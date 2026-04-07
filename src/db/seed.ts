import { pool } from "./client.js";

async function seed(): Promise<void> {
  console.log("Seeding database...");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert 2 test protocols
    const rewardzProtocolId = "00000000-0000-0000-0000-000000000001";
    const partnerProtocolId = "00000000-0000-0000-0000-000000000002";

    await client.query(
      `INSERT INTO protocols (id, admin_wallet, name, description, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        rewardzProtocolId,
        "RWDZadmin1111111111111111111111111111111111",
        "REWARDZ Protocol",
        "Core REWARDZ mining game protocol",
        "active",
      ],
    );

    await client.query(
      `INSERT INTO protocols (id, admin_wallet, name, description, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        partnerProtocolId,
        "PARTNRadmin11111111111111111111111111111111",
        "Test Partner",
        "A test partner protocol for development",
        "active",
      ],
    );

    console.log("  OK  Protocols seeded");

    // Insert 1 campaign per protocol
    const rewardzCampaignId = "00000000-0000-0000-0000-000000000011";
    const partnerCampaignId = "00000000-0000-0000-0000-000000000012";

    await client.query(
      `INSERT INTO campaigns (campaign_id, protocol_id, name, description, action_type, points_per_completion, max_per_user_per_day, budget_total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (campaign_id) DO NOTHING`,
      [
        rewardzCampaignId,
        rewardzProtocolId,
        "Daily Mining Bonus",
        "Earn bonus points for daily mining activity",
        "mine",
        100,
        1,
        1000000,
        "active",
      ],
    );

    await client.query(
      `INSERT INTO campaigns (campaign_id, protocol_id, name, description, action_type, points_per_completion, max_per_user_per_day, budget_total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (campaign_id) DO NOTHING`,
      [
        partnerCampaignId,
        partnerProtocolId,
        "Partner Swap Campaign",
        "Earn points for swapping via partner protocol",
        "swap",
        50,
        3,
        500000,
        "active",
      ],
    );

    console.log("  OK  Campaigns seeded");

    // Insert 3 test users
    const testWallets = [
      "TESTuser1111111111111111111111111111111111111",
      "TESTuser2222222222222222222222222222222222222",
      "TESTuser3333333333333333333333333333333333333",
    ];

    for (let i = 0; i < testWallets.length; i++) {
      const wallet = testWallets[i];
      const points = (i + 1) * 1000;

      await client.query(
        `INSERT INTO users (wallet_address, total_points, synced_points)
         VALUES ($1, $2, $3)
         ON CONFLICT (wallet_address) DO NOTHING`,
        [wallet, points, points],
      );

      await client.query(
        `INSERT INTO user_balances (wallet_address, total_earned, total_pending, total_spent, total_reserved)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (wallet_address) DO NOTHING`,
        [wallet, points, 0, 0, 0],
      );
    }

    console.log("  OK  Users seeded");

    // Insert 1 composable quest with 2 steps
    const questId = "00000000-0000-0000-0000-000000000021";

    await client.query(
      `INSERT INTO quests (quest_id, name, description, quest_type, conditions, reward_points, bonus_multiplier, composition_mode, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (quest_id) DO NOTHING`,
      [
        questId,
        "Swap & Tweet Quest",
        "Complete a swap and tweet about it for bonus points",
        "composable",
        JSON.stringify({ steps_required: 2 }),
        200,
        1.5,
        "closed",
        rewardzProtocolId,
        "active",
      ],
    );

    await client.query(
      `INSERT INTO quest_steps (quest_id, step_index, intent_type, protocol_id, params, points)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (quest_id, step_index) DO NOTHING`,
      [
        questId,
        0,
        "swap",
        partnerProtocolId,
        JSON.stringify({ min_amount: 10 }),
        100,
      ],
    );

    await client.query(
      `INSERT INTO quest_steps (quest_id, step_index, intent_type, protocol_id, params, points, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (quest_id, step_index) DO NOTHING`,
      [
        questId,
        1,
        "tweet",
        rewardzProtocolId,
        JSON.stringify({ required_hashtags: ["#REWARDZ"] }),
        100,
        0,
      ],
    );

    console.log("  OK  Quests seeded");

    // Insert 1 leaderboard season
    const seasonId = "00000000-0000-0000-0000-000000000031";

    await client.query(
      `INSERT INTO leaderboard_seasons (id, name, description, start_at, is_active)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (id) DO NOTHING`,
      [seasonId, "Season 1", "Launch season", true],
    );

    console.log("  OK  Leaderboard season seeded");

    await client.query("COMMIT");
    console.log("Seeding complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seeding failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
