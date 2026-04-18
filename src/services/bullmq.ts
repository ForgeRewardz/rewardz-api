/**
 * Shared BullMQ queue + Redis connection for the discovery scheduler.
 *
 * Why lazy: the module is imported at server boot (via routes/discovery.ts)
 * but we don't want to open a Redis socket until the first schedule is
 * enqueued OR the first worker is started. Tests in environments without
 * Redis should be able to import the module without triggering a
 * connection; callers decide when to materialise the queue by calling
 * `discoveryQueue()` / `startDiscoveryWorker()`.
 *
 * Why a singleton: BullMQ queues are expensive (each wraps a dedicated
 * Redis client) and jobId-based deduplication (`DELETE /scheduled/:id`
 * uses `queue.remove(jobId)`) only works if all callers see the same
 * Queue instance. The Worker singleton is enforced for the same reason
 * — a second Worker on the same queue name would double-process jobs.
 *
 * Producer (`discoveryQueue()`) and consumer (`startDiscoveryWorker()`)
 * live in the SAME process for single-instance deployments. The boot
 * wiring in `server.ts` gates worker creation behind
 * `config.DISCOVERY_WORKER_ENABLED` so API-only replicas can skip the
 * consumer entirely.
 */

import { Queue, type Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { config } from "../config.js";

/** Name of the discovery queue — shared by producer + worker. */
export const DISCOVERY_QUEUE_NAME = "discovery:scheduled";

/**
 * Payload enqueued by `POST /v1/discovery/schedule`. The worker reads
 * this shape to re-run `resolveIntent` at `run_at` and persist the
 * result to `discovery_results`.
 */
export interface DiscoveryJobData {
  scheduleId: string;
  wallet: string;
  text: string;
}

let queueInstance: Queue<DiscoveryJobData> | null = null;
let workerInstance: Worker<DiscoveryJobData> | null = null;
let connection: IORedis | null = null;

/**
 * Shared IORedis connection factory. Exported so the discovery-runner
 * worker can reuse the same client the Queue uses — BullMQ requires
 * `maxRetriesPerRequest: null` on both ends, and minting one
 * connection avoids doubling up ioredis sockets per process.
 */
export function lazyConnection(): IORedis {
  if (!connection) {
    // BullMQ requires `maxRetriesPerRequest: null` on its connection —
    // otherwise blocking commands (used by the worker) raise errors
    // instead of retrying transparently. Setting it here keeps the
    // producer/worker connection config aligned.
    connection = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

/** Shared Queue instance. Lazily constructs on first call. */
export function discoveryQueue(): Queue<DiscoveryJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<DiscoveryJobData>(DISCOVERY_QUEUE_NAME, {
      connection: lazyConnection(),
    });
  }
  return queueInstance;
}

/**
 * Lazily construct + return the singleton discovery Worker. The
 * `createDiscoveryWorker` factory is imported dynamically so this
 * module stays importable in environments that can't load the worker
 * file (e.g. when testing the queue-only producer path).
 *
 * Safe to call more than once: the second call returns the existing
 * instance rather than spawning a parallel consumer.
 */
export async function startDiscoveryWorker(): Promise<
  Worker<DiscoveryJobData>
> {
  if (!workerInstance) {
    // Dynamic import avoids a static cycle with workers/discovery-runner.ts
    // (the worker imports `lazyConnection` + `DISCOVERY_QUEUE_NAME` +
    // `DiscoveryJobData` from this file).
    const { createDiscoveryWorker } =
      await import("../workers/discovery-runner.js");
    workerInstance = createDiscoveryWorker();
  }
  return workerInstance;
}

/**
 * Close the discovery worker. Call before `closeDiscoveryQueue()` to
 * stop new jobs from being picked up before the queue tears down.
 * `closeDiscoveryQueue` invokes this automatically so most callers
 * don't need to touch it directly.
 */
export async function stopDiscoveryWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}

/**
 * Tear down the shared worker + queue + Redis connection, in that
 * order. Intended for test teardown and graceful shutdown — leaves the
 * module in a re-usable state (next `discoveryQueue()` /
 * `startDiscoveryWorker()` call will build fresh instances).
 *
 * Ordering matters: the Worker must close BEFORE the Queue so an
 * in-flight job can finish its DB writes using the shared ioredis
 * client, and both must close BEFORE we `quit()` the connection so
 * BullMQ's graceful-close path can still send commands on its way out.
 */
export async function closeDiscoveryQueue(): Promise<void> {
  await stopDiscoveryWorker();
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
