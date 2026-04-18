import "dotenv/config";
import { z } from "zod";
import {
  DEVNET,
  MAINNET,
  type LeagueConfig,
  type Network,
} from "@rewardz/types";
import { BASE58_PUBKEY } from "./types/solana.js";

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@127.0.0.1:5432/rewardz"),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  // Colosseum Rewardz League preset selector. Unknown values fail fast on boot
  // via zod — there is no silent fall-through (per league-config.md).
  // `localnet` is accepted (for local surfpool dev) and transformed to `devnet`
  // since the LeagueConfig preset is identical; keeps the downstream Network
  // type narrow (devnet | mainnet) while matching the canonical env value in
  // mobileSpecs/.env.shared.example. Mirrors the shadow mapping already in
  // mvp-smart-contracts/setup.sh:75-82.
  SOLANA_NETWORK: z
    .enum(["devnet", "mainnet", "localnet"])
    .default("devnet")
    .transform((v): Network => (v === "localnet" ? "devnet" : v)),
  GEMINI_API_KEY: z.string().optional(), // Optional: rules-based fallback when unavailable
  DISCOVERY_LLM_MAX_RPS: z.coerce.number().int().positive().default(5),
  // Internal token-bucket rate-limit for the Gemini classifier used by
  // resolveIntent. When exceeded the resolver short-circuits to the
  // rules-based matcher rather than returning an error. See
  // mini-app-ux-spec.md §7.5.
  TWITTER_BEARER_TOKEN: z.string().optional(), // Optional: tweet verification is stubbed
  ZEALY_DEFAULT_SECRET: z.string().optional(),
  POINTS_AWARD_RATE_LIMIT: z.coerce.number().default(100),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  INTERNAL_API_KEY: z.string().min(1, "INTERNAL_API_KEY is required"),
  ALLOWED_ORIGINS: z.string().optional(), // Comma-separated allowed CORS origins
  // Symmetric key used by pgcrypto `pgp_sym_encrypt` for airdrop signup
  // emails (per mini-app-spec.md §Airdrop). Optional at boot so dev
  // environments without an airdrop signup flow don't need to set it;
  // the `/airdrop/signup` handler itself returns 503 if missing so a
  // misconfigured prod doesn't silently store plaintext.
  AIRDROP_EMAIL_KEY: z.string().optional(),
  // Comma-separated base58 pubkeys allowed to hit admin-only endpoints.
  // Empty / unset env ⇒ empty array ⇒ all admin calls are rejected.
  // Invalid base58 entries ⇒ boot fails with a clear zod error (instead
  // of silently letting a typo'd wallet slip through as an "admin" that
  // can never actually match — Klaus code-review R17).
  ADMIN_WALLETS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    )
    .refine((arr) => arr.every((w) => BASE58_PUBKEY.test(w)), {
      message:
        "ADMIN_WALLETS must be a comma-separated list of valid base58 Solana pubkeys (32-44 chars, base58 alphabet)",
    }),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;

// League preset resolved at boot. Uses the zod-narrowed SOLANA_NETWORK so the
// single authoritative parse lives in envSchema above (no second process.env read).
const LEAGUE_PRESETS: Record<Network, LeagueConfig> = {
  devnet: DEVNET,
  mainnet: MAINNET,
};
export const league: LeagueConfig = LEAGUE_PRESETS[config.SOLANA_NETWORK];
