// Vitest setupFiles entry — runs before any test file loads.
// Seeds the minimum env vars required by src/config.ts so service tests
// can import { config } without triggering the zod process.exit in
// environments that don't have a .env file (CI).
//
// Only seeds secrets with no safe default. DATABASE_URL / SOLANA_* have
// working defaults in src/config.ts and don't need seeding. Use `??=`
// so any real env (e.g. from the shell or a loaded .env) always wins.

process.env.JWT_SECRET ??= "test-jwt-secret-must-be-at-least-32-chars-long";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-for-vitest-runs";
