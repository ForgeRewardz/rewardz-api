/**
 * Shared protocol-registry read helper.
 *
 * Returns the set of `status = 'active'` protocol rows used by the intent
 * resolver. Extracted from `routes/discovery.ts` so the scheduled-discovery
 * worker (`workers/discovery-runner.ts`) and the synchronous
 * `POST /v1/discovery/query` handler share one definition of "active
 * protocols" — previously the SELECT was duplicated across files and drift
 * was flagged in the T9/T10 code review.
 *
 * NOTE: `routes/intents.ts` keeps its own copy on purpose — changing that
 * file is out of scope for task 12 and the query is small enough that
 * cross-file drift between intents.ts and this helper stays easy to eyeball.
 */

import { query } from "../db/client.js";
import type { Protocol } from "../types/index.js";

export async function listActiveProtocols(): Promise<Protocol[]> {
  const result = await query<Protocol>(
    `SELECT id, admin_wallet, name, description, blink_base_url, supported_actions,
            trust_score, status, created_at, updated_at
       FROM protocols
      WHERE status = 'active'`,
  );
  return result.rows;
}
