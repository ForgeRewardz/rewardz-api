# Follow-ups

## Session 1+2 follow-ups (2026-04-18)

### Test-env seeding sweep

Moving 14 test files from the legacy `process.env.X ??= ...` pattern at the top of each file to the new `tests/setup-env.ts` + `vitest.config.ts` setupFiles hook introduced in Session 1. The T7 fixup migrated `tests/services/intent-resolver.test.ts` only; the remaining files still carry the redundant pattern:

- `tests/services/game-service.test.ts`
- `tests/services/verifier-adapters.test.ts`
- `tests/services/leaderboard-service.test.ts`
- `tests/services/game-event-replay.test.ts`
- `tests/services/batch-award-rollback.test.ts`
- `tests/routes/admin.e2e.test.ts`
- `tests/routes/campaigns.e2e.test.ts`
- `tests/routes/leaderboards.e2e.test.ts`
- `tests/routes/game.e2e.test.ts`
- `tests/routes/auth.e2e.test.ts`
- `tests/routes/blinks.e2e.test.ts`
- `tests/capacity.test.ts`

**Fix:** mechanical grep-and-delete sweep. Each file just loses the top-of-file env seeding lines.

### Discovery chat observability

- `src/services/intent-resolver.ts` silent `catch {}` inside the try/catch around `resolveWithAI` swallows Gemini errors silently. Precedent exists in `tweet-verifier.ts`, but once Gemini actually gets provisioned we need metrics on fallback rate — add a `discovery_fallback_total` counter and log `{ reason: "rate_limit" | "provider_error" | "no_api_key" }`.
- `src/workers/discovery-runner.ts` uses `console.error` for `failed` + `error` events. Inject Fastify's `app.log` (or use pino directly) so worker logs appear in the same structured-log pipeline as HTTP requests.

### Discovery scheduling hardening

- `POST /v1/discovery/schedule` cap check is documented as "soft advisory" — TOCTOU race allows a 6th row under concurrent POSTs. Tighten via `pg_advisory_xact_lock(hashtext(wallet))` or a partial unique trigger.
- `DELETE /v1/discovery/scheduled/:id` overly broad `queue.remove()` catch swallows Redis-connection errors. Narrow to BullMQ's `JobNotFoundError` and let real outages propagate (DELETE returns 500 so the caller retries).
- Worker `status='running'` UPDATE doesn't check `rowCount`; silently no-ops on unexpected state. Add a `rowCount === 0` early-return with a log.
- Scheduler integration test for pre-run cancel uses a fixed 2s sleep — replace with poll on `QueueEvents` for `completed`/`failed`.

### OpenAPI + ops

- No route serves `openapi.json` at runtime — spec exists on disk at `openapi.yaml` only. If clients are expected to fetch the spec at runtime, add a static route.
- Smoke-boot warning "REWARDZ_MVP_PROGRAM_ID is unset — adapters will reject every real transaction" is expected in test env but a production deploy MUST set this.
- `pnpm add bullmq` required `npx pnpm@10 --ignore-workspace` because the root `pnpm.overrides` points at `file:../sdk/packages/types` — a sibling workspace that doesn't exist at the mobileSpecs root level. Worth either moving api into the mobileSpecs workspace or fixing the override path.

### Pre-existing regression

- `tests/league-config-parity.test.ts` was initially reported as timing out (the rust dump-config binary). Passed during verify (5486ms) — monitor in CI.
