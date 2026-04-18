/**
 * BullMQ Worker that consumes `discovery:scheduled` jobs at their
 * scheduled `runAt`, replays the stored query through `resolveIntent`,
 * and persists the outcome to `discovery_results`.
 *
 * Lifecycle:
 *   - Constructed via `createDiscoveryWorker()` (see services/bullmq.ts
 *     `startDiscoveryWorker`, which owns the singleton).
 *   - Closed via `stopDiscoveryWorker()` which is in turn invoked by
 *     `closeDiscoveryQueue()` on Fastify `onClose`.
 *
 * Safety rails:
 *   - The schedule row is re-read at the top of the handler so a
 *     cancellation that lost the race with the `DELETE /scheduled/:id`
 *     queue.remove (best-effort in routes/discovery.ts) still no-ops
 *     here rather than producing an unwanted result row.
 *   - A missing schedule row (e.g. race between COMMIT + enqueue) is
 *     logged and dropped — the job is considered "handled" so BullMQ
 *     won't retry a permanently-broken id.
 *   - On any other error we let BullMQ's retry policy (attempts=3,
 *     exponential backoff starting at 30s, configured by the producer
 *     in routes/discovery.ts) take over. After exhaustion
 *     `removeOnFail: false` preserves the failed job for inspection.
 *
 * See mini-app-ux-spec.md §7.6 / §13 for the UX and API contract.
 */

import { type Job, Worker } from "bullmq";
import { query } from "../db/client.js";
import {
  formatAssistantText,
  resolverFellBackToRules,
} from "../services/discovery-format.js";
import {
  DISCOVERY_QUEUE_NAME,
  type DiscoveryJobData,
  lazyConnection,
} from "../services/bullmq.js";
import { resolveIntent } from "../services/intent-resolver.js";
import { listActiveProtocols } from "../services/protocol-registry.js";

/**
 * Concurrency cap — small because each job takes a single Postgres
 * round-trip per step plus (optionally) a Gemini call. Five is the
 * middle ground between "useful under load" and "not enough Gemini
 * quota for a burst". Tune via a dedicated env if scheduler throughput
 * ever becomes a bottleneck.
 */
const DISCOVERY_WORKER_CONCURRENCY = 5;

/**
 * Build the Worker. Exported so services/bullmq.ts can construct the
 * singleton lazily — call sites outside that module should go through
 * `startDiscoveryWorker()` to avoid double-instantiation.
 */
export function createDiscoveryWorker(): Worker<DiscoveryJobData> {
  const worker = new Worker<DiscoveryJobData>(
    DISCOVERY_QUEUE_NAME,
    processDiscoveryJob,
    {
      // BullMQ docs recommend a dedicated connection for the Worker —
      // it issues blocking commands (BRPOPLPUSH / BZPOPMIN) that would
      // otherwise back up ad-hoc commands on the shared ioredis socket.
      // `worker.close()` closes the duplicated connection automatically,
      // so no separate bookkeeping is needed in closeDiscoveryQueue.
      connection: lazyConnection().duplicate(),
      concurrency: DISCOVERY_WORKER_CONCURRENCY,
      // BullMQ automatically retries per the job's attempts + backoff
      // config, set at enqueue time in routes/discovery.ts.
    },
  );

  // Log-only listeners — we don't swallow errors (the job handler
  // already decides what to rethrow). Visibility matters because a
  // silently dead worker is the worst-case scheduler failure mode.
  worker.on("failed", (job, err) => {
    // biome-ignore lint/suspicious/noConsole: worker observability
    console.error(
      `[discovery-runner] job ${job?.id} failed after ${job?.attemptsMade} attempts: ${err.message}`,
    );
  });
  worker.on("error", (err) => {
    // biome-ignore lint/suspicious/noConsole: worker observability
    console.error("[discovery-runner] worker error:", err);
  });

  return worker;
}

/**
 * The job processor. Exported separately so tests can drive it with a
 * mocked Job without standing up a full Worker + Redis — see
 * tests/workers/discovery-runner.test.ts.
 */
export async function processDiscoveryJob(
  job: Job<DiscoveryJobData>,
): Promise<void> {
  const { scheduleId, wallet, text } = job.data;

  // Re-check the schedule row. Closes two races:
  //   1. DELETE endpoint's best-effort queue.remove lost the race
  //      with the worker picking up the delayed job (status is
  //      now 'cancelled' but the job still fired).
  //   2. The row was never committed — e.g. the enqueue happened
  //      but the containing transaction rolled back.
  const sched = await query<{ status: string }>(
    "SELECT status FROM discovery_schedules WHERE id = $1",
    [scheduleId],
  );
  if (sched.rowCount === 0) {
    job.log(`schedule ${scheduleId} not found; dropping`);
    return;
  }
  if (sched.rows[0].status === "cancelled") {
    job.log(`schedule ${scheduleId} cancelled; dropping`);
    return;
  }

  // Mark running. Guarded on status='pending' so a requeued job that
  // somehow re-enters after completion can't flip a 'done' row back
  // to 'running' — UPDATE with no matching row is a silent no-op.
  await query(
    "UPDATE discovery_schedules SET status = 'running' WHERE id = $1 AND status = 'pending'",
    [scheduleId],
  );

  // Let resolveIntent errors propagate — BullMQ retries per the
  // producer's attempts config. Swallowing here would hide legitimate
  // infrastructure failures behind a silently-missing results row.
  const protocols = await listActiveProtocols();
  const result = await resolveIntent(text, wallet, protocols);

  const assistantText = formatAssistantText(result);
  const matches = result.offers.map((o) => ({
    protocolId: o.protocol_id,
    protocolName: o.protocol_name,
    actionType: o.action_type,
    points: o.points,
  }));
  const fellBack = resolverFellBackToRules(result);

  // ON CONFLICT DO NOTHING makes the INSERT idempotent across retries
  // — if BullMQ re-runs a job whose first attempt already wrote the
  // row (e.g. after a DB blip after INSERT but before the status
  // flip), we don't double-write or throw a PK violation.
  await query(
    `INSERT INTO discovery_results (schedule_id, assistant, matches, fell_back)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (schedule_id) DO NOTHING`,
    [
      scheduleId,
      JSON.stringify({
        text: assistantText,
        intent: result.action_type,
        resolverType: result.resolver_type,
        confidence: result.confidence,
      }),
      JSON.stringify(matches),
      fellBack,
    ],
  );

  // Guard on status='running' so a mid-run cancel (user DELETE while
  // resolveIntent was executing) isn't stomped back to 'done'. The
  // result row already landed via ON CONFLICT DO NOTHING above — we
  // intentionally keep it so the user can still see the outcome of a
  // run that got far enough to produce one, but the schedule's
  // cancelled status is preserved as the source of truth.
  await query(
    "UPDATE discovery_schedules SET status = 'done' WHERE id = $1 AND status = 'running'",
    [scheduleId],
  );
}
