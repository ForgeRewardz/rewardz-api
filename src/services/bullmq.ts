/**
 * Shared BullMQ queue + Redis connection for the discovery scheduler.
 *
 * Why lazy: the module is imported at server boot (via routes/discovery.ts)
 * but we don't want to open a Redis socket until the first schedule is
 * enqueued. Tests in environments without Redis should be able to import
 * the module without triggering a connection; callers decide when to
 * materialise the queue by calling `discoveryQueue()`.
 *
 * Why a singleton: BullMQ queues are expensive (each wraps a dedicated
 * Redis client) and jobId-based deduplication (`DELETE /scheduled/:id`
 * uses `queue.remove(jobId)`) only works if all callers see the same
 * Queue instance.
 *
 * The companion worker (to be added in a follow-up task) lives in a
 * separate process, so this module only exports the producer side —
 * `Queue` + `IORedis` connection. Workers will import `IORedis` and
 * `Worker` themselves.
 */

import { Queue } from "bullmq";
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
let connection: IORedis | null = null;

function lazyConnection(): IORedis {
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
 * Tear down the shared queue + Redis connection. Intended for test
 * teardown and graceful shutdown — leaves the module in a re-usable
 * state (next `discoveryQueue()` call will build fresh instances).
 */
export async function closeDiscoveryQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
