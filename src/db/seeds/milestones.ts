// Milestone catalogue + reward seed (Colosseum Rewardz League).
//
// Values mirror `league-config.md` §Milestones (activation / growth / social).
// Idempotent: ON CONFLICT DO NOTHING on milestones.slug, ON CONFLICT DO NOTHING
// on (milestone_id, network, effective_from) for milestone_rewards.
//
// Run via `pnpm --filter @rewardz/api tsx src/db/seeds/milestones.ts`, or call
// `seedMilestones(client)` from the main seed runner.

import type { PoolClient } from "pg";
import { pool } from "../client.js";

type Bucket = "activation" | "growth" | "social";
type Network = "devnet" | "mainnet";

interface MilestoneSeed {
  slug: string;
  bucket: Bucket;
  description: string;
  rewardz: number;
}

// Devnet milestone schedule. Mainnet values are seeded separately when the
// league config graduates out of zero-placeholder mode.
const DEVNET_MILESTONES: MilestoneSeed[] = [
  // Activation
  {
    slug: "first_blink",
    bucket: "activation",
    description: "Protocol's first successful Blink interaction",
    rewardz: 100,
  },
  {
    slug: "first_stake",
    bucket: "activation",
    description: "Protocol's first stake or deposit action",
    rewardz: 100,
  },
  {
    slug: "first_issuance",
    bucket: "activation",
    description: "Protocol's first Rewardz issuance to an external wallet",
    rewardz: 150,
  },
  {
    slug: "first_five_unique_wallets",
    bucket: "activation",
    description: "Five distinct external wallets completed a protocol action",
    rewardz: 150,
  },
  {
    slug: "first_repeat_user",
    bucket: "activation",
    description:
      "A wallet returned after the repeat_user_gap_hours window and acted again",
    rewardz: 100,
  },
  // Growth
  {
    slug: "twenty_five_unique_wallets",
    bucket: "growth",
    description: "Twenty-five distinct external wallets have acted on the protocol",
    rewardz: 100,
  },
  {
    slug: "ten_repeat_users",
    bucket: "growth",
    description: "Ten wallets returned after the repeat gap and acted again",
    rewardz: 150,
  },
  // Social
  {
    slug: "follow_league",
    bucket: "social",
    description: "Protocol's X account followed the Rewardz League account",
    rewardz: 10,
  },
  {
    slug: "launch_thread",
    bucket: "social",
    description: "Protocol published a launch thread tagging the Rewardz League",
    rewardz: 25,
  },
];

export async function seedMilestones(
  client: PoolClient,
  network: Network = "devnet",
): Promise<void> {
  const schedule = network === "devnet" ? DEVNET_MILESTONES : [];
  if (schedule.length === 0) {
    console.log(`  SKIP milestones (no schedule for network=${network})`);
    return;
  }

  for (const m of schedule) {
    await client.query(
      `INSERT INTO milestones (slug, bucket, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [m.slug, m.bucket, m.description],
    );

    // Reward row references milestone by slug lookup so we remain agnostic to
    // BIGSERIAL id assignment order across re-runs.
    await client.query(
      `INSERT INTO milestone_rewards (milestone_id, rewardz_amount, network)
       SELECT id, $2, $3 FROM milestones WHERE slug = $1
       ON CONFLICT (milestone_id, network, effective_from) DO NOTHING`,
      [m.slug, m.rewardz, network],
    );
  }

  console.log(`  OK  Milestones seeded (${schedule.length} rows, ${network})`);
}

async function main(): Promise<void> {
  const network = (process.env.SOLANA_NETWORK ?? "devnet") as Network;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await seedMilestones(client, network);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Milestone seed failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

// Only run as script when invoked directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
