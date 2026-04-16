import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

describe("Migration files", () => {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("should have exactly 46 migration files", () => {
    expect(files.length).toBe(46);
  });

  it("should have filenames in correct order (001-046)", () => {
    for (let i = 0; i < 46; i++) {
      const expected = String(i + 1).padStart(3, "0");
      expect(files[i]).toMatch(new RegExp(`^${expected}_`));
    }
  });

  it("should have each file starting with CREATE or ALTER", () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      // Strip leading SQL comments and blank lines, then ensure the first
      // statement is either CREATE or ALTER (some migrations only alter).
      const stripped = content
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim();
      expect(stripped).toMatch(/^(CREATE|ALTER)\s/i);
    }
  });

  it("should have valid SQL in each migration file", () => {
    // Migrations that create a table keyed by file → expected table name.
    const expectedTables: Record<string, string> = {
      "001_users.sql": "users",
      "002_merkle_proofs.sql": "merkle_proofs",
      "003_protocols.sql": "protocols",
      "004_reward_policies.sql": "reward_policies",
      "005_campaigns.sql": "campaigns",
      "006_completions.sql": "completions",
      "007_protocol_manifests.sql": "protocol_manifests",
      "008_quests.sql": "quests",
      "009_quest_progress.sql": "quest_progress",
      "010_quest_steps.sql": "quest_steps",
      "011_quest_collaborators.sql": "quest_collaborators",
      "012_subscriptions.sql": "subscriptions",
      "013_delegations.sql": "delegations",
      "014_delegation_triggers.sql": "delegation_triggers",
      "015_delegation_audit_log.sql": "delegation_audit_log",
      "016_tweet_verification_rules.sql": "tweet_verification_rules",
      "017_tweet_submissions.sql": "tweet_submissions",
      "018_point_events.sql": "point_events",
      "019_user_balances.sql": "user_balances",
      "020_marketing_spends.sql": "marketing_spends",
      "021_penalty_events.sql": "penalty_events",
      "022_admin_audit_log.sql": "admin_audit_log",
      "023_leaderboard_seasons.sql": "leaderboard_seasons",
      "024_protocol_scores.sql": "protocol_scores",
      "025_user_season_scores.sql": "user_season_scores",
      "026_leaderboard_snapshots.sql": "leaderboard_snapshots",
      "027_rental_settlements.sql": "rental_settlements",
      "028_telegram_users.sql": "telegram_users",
      "029_point_deductions.sql": "point_deductions",
      "031_protocol_auth_sessions.sql": "protocol_auth_sessions",
      "032_protocol_idls.sql": "protocol_idls",
      "033_program_profiles.sql": "program_profiles",
      "034_protocol_blinks.sql": "protocol_blinks",
      "037_game_rounds.sql": "game_rounds",
      "040_league_tables.sql": "milestones",
      "041_referrals_airdrop.sql": "referrals",
    };

    // Migrations that do NOT create a table — each must define a regex the
    // file body is expected to match.
    const expectedAlters: Record<string, RegExp> = {
      "030_merkle_proofs_unique_epoch_authority.sql":
        /ALTER TABLE\s+merkle_proofs/i,
      "035_campaigns_extensions.sql":
        /ALTER TABLE\s+campaigns[\s\S]*ADD COLUMN\s+verification_config/i,
      "036_point_events_channel.sql":
        /ALTER TABLE\s+point_events[\s\S]*ADD COLUMN\s+channel/i,
      "038_game_rounds_settle_snapshot.sql":
        /ALTER TABLE\s+game_rounds[\s\S]*ADD COLUMN\s+IF NOT EXISTS\s+settle_timestamp/i,
      "039_protocols_league_cols.sql":
        /ALTER TABLE\s+protocols[\s\S]*ADD COLUMN\s+IF NOT EXISTS\s+referral_code/i,
      "042_rewardz_earnings_protocol_id.sql":
        /ALTER TABLE\s+rewardz_earnings[\s\S]*ADD COLUMN\s+IF NOT EXISTS\s+protocol_id/i,
      "043_abuse_flags_open_unique.sql":
        /CREATE UNIQUE INDEX[\s\S]*abuse_flags_open_unique_idx[\s\S]*WHERE\s+resolved_at IS NULL/i,
      "044_abuse_flags_daily_cap_kind.sql":
        /ALTER TABLE\s+abuse_flags[\s\S]*ADD CONSTRAINT[\s\S]*daily_cap_breach/i,
      "045_rewardz_earnings_reason_unique.sql":
        /CREATE UNIQUE INDEX[\s\S]*rewardz_earnings_protocol_reason_unique_idx[\s\S]*WHERE\s+milestone_id IS NULL/i,
      "046_protocols_active_stake.sql":
        /ALTER TABLE\s+protocols[\s\S]*ADD COLUMN\s+IF NOT EXISTS\s+active_stake/i,
    };

    for (const file of files) {
      const content = fs
        .readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8")
        .trim();
      if (file in expectedTables) {
        const expectedTable = expectedTables[file];
        expect(content).toContain(`CREATE TABLE ${expectedTable}`);
      } else if (file in expectedAlters) {
        expect(content).toMatch(expectedAlters[file]);
      } else {
        throw new Error(
          `Migration ${file} is not declared in expectedTables or expectedAlters`,
        );
      }
    }
  });
});
