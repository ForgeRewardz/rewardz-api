import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@127.0.0.1:5432/rewardz"),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  GEMINI_API_KEY: z.string().optional(), // Optional: rules-based fallback when unavailable
  TWITTER_BEARER_TOKEN: z.string().optional(), // Optional: tweet verification is stubbed
  ZEALY_DEFAULT_SECRET: z.string().optional(),
  POINTS_AWARD_RATE_LIMIT: z.coerce.number().default(100),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  INTERNAL_API_KEY: z.string().min(1, "INTERNAL_API_KEY is required"),
  ALLOWED_ORIGINS: z.string().optional(), // Comma-separated allowed CORS origins
  // Comma-separated base58 pubkeys allowed to hit admin-only endpoints.
  // Empty / unset env ⇒ empty array ⇒ all admin calls are rejected.
  ADMIN_WALLETS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    ),
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
