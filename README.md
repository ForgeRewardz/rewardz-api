# @rewardz/api

Fastify REST API powering the REWARDZ mobile app. Handles intent resolution, points accounting, quests, protocol management, delegations, subscriptions, and social verification.

## Local dev

Part of the REWARDZ `mobileSpecs/` stack. For the full local setup (shared env, docker compose, bootstrap orchestrator), see [`../LOCAL-SETUP.md`](../LOCAL-SETUP.md).

Quick path (from mobileSpecs/ root):

```bash
cp .env.shared.example .env.shared && $EDITOR .env.shared
./scripts/bootstrap-local.sh
# api now on http://localhost:3001/healthz
```

## Running Locally

Prerequisites: Node 22+, pnpm, PostgreSQL 16 running on `localhost:5432`.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET and INTERNAL_API_KEY

# 3. Set up the database
pnpm migrate    # apply all SQL migrations
pnpm seed       # (optional) load test data

# 4. Start the dev server
pnpm dev        # http://localhost:3001 with hot reload
```

To run the compiled production build locally:

```bash
pnpm build
pnpm start      # node dist/server.js on :3001
```

Verify it's running:

```bash
curl http://localhost:3001/healthz
# {"status":"ok","timestamp":"...","db":"connected"}
```

## Deploying with Docker

The `docker-compose.yml` spins up both PostgreSQL and the API:

```bash
# Start everything (detached)
docker compose up -d

# API is available at http://localhost:3001
# Postgres is available at localhost:5432
```

To override environment variables, either edit `docker-compose.yml` or pass an env file:

```bash
docker compose --env-file .env.production up -d
```

To build and run the API image standalone (when Postgres is managed separately):

```bash
# Build the image
docker build -t rewardz-api .

# Run with your own database
docker run -d \
  -p 3001:3001 \
  -e DATABASE_URL=postgres://user:pass@your-db:5432/rewardz \
  -e JWT_SECRET=your-secret \
  -e INTERNAL_API_KEY=your-key \
  rewardz-api
```

Run migrations inside the container:

```bash
docker compose exec api node dist/db/migrate.js
```

## Scripts

| Script         | Description                                  |
| -------------- | -------------------------------------------- |
| `pnpm dev`     | Start dev server with hot reload (tsx watch) |
| `pnpm build`   | Compile TypeScript to `dist/`                |
| `pnpm start`   | Run compiled server (`node dist/server.js`)  |
| `pnpm test`    | Run tests (Vitest)                           |
| `pnpm migrate` | Apply database migrations                    |
| `pnpm seed`    | Seed test data                               |

## Environment Variables

| Variable                  | Required | Default                                               | Description                                                                |
| ------------------------- | -------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `JWT_SECRET`              | Yes      | -                                                     | Secret for signing/verifying JWTs                                          |
| `INTERNAL_API_KEY`        | Yes      | -                                                     | Shared key for keeper-bot / internal services                              |
| `DATABASE_URL`            | No       | `postgres://postgres:postgres@127.0.0.1:5432/rewardz` | PostgreSQL connection string                                               |
| `PORT`                    | No       | `3001`                                                | Server listen port                                                         |
| `SOLANA_RPC_URL`          | No       | `https://api.devnet.solana.com`                       | Solana RPC endpoint                                                        |
| `GEMINI_API_KEY`          | No       | -                                                     | Gemini API key for AI intent resolution (rules-based fallback when absent) |
| `TWITTER_BEARER_TOKEN`    | No       | -                                                     | Twitter API token for tweet verification (stubbed when absent)             |
| `ZEALY_DEFAULT_SECRET`    | No       | -                                                     | Zealy webhook secret                                                       |
| `POINTS_AWARD_RATE_LIMIT` | No       | `100`                                                 | Max point awards per window                                                |
| `ALLOWED_ORIGINS`         | No       | `http://localhost:3000`                               | Comma-separated CORS origins                                               |

## API Routes

All routes are prefixed with `/v1` unless noted otherwise.

### Health

| Method | Path       | Auth | Description                    |
| ------ | ---------- | ---- | ------------------------------ |
| GET    | `/healthz` | None | Health check (no `/v1` prefix) |

### Intents

| Method | Path                  | Auth   | Description                                                   |
| ------ | --------------------- | ------ | ------------------------------------------------------------- |
| POST   | `/v1/intents/resolve` | Wallet | Resolve a natural-language intent into ranked protocol offers |

### Points

| Method | Path                     | Auth    | Description                           |
| ------ | ------------------------ | ------- | ------------------------------------- |
| GET    | `/v1/points/balance`     | Wallet  | Get point balance for a wallet        |
| GET    | `/v1/points/history`     | Wallet  | Paginated point event history         |
| POST   | `/v1/points/award`       | API Key | Award points to a wallet (idempotent) |
| POST   | `/v1/points/award/batch` | API Key | Batch award points (max 100)          |

### Quests

| Method | Path                                       | Auth   | Description                                        |
| ------ | ------------------------------------------ | ------ | -------------------------------------------------- |
| GET    | `/v1/quests`                               | None   | List quests (filterable by type/status, paginated) |
| GET    | `/v1/quests/:id`                           | None   | Get quest details with steps                       |
| POST   | `/v1/quests/:id/join`                      | Wallet | Join a quest                                       |
| GET    | `/v1/quests/:id/progress`                  | Wallet | Get quest progress                                 |
| POST   | `/v1/quests/:id/steps/:stepIndex/complete` | Wallet | Complete a quest step                              |
| GET    | `/v1/quests/my`                            | Wallet | List joined quests                                 |

### Mining Game

Read-only views into the on-chain mining round. State is populated by the
`game-event-listener` service as the on-chain program emits `RoundStarted` /
`PlayerDeployed` / `RoundSettled` / `CheckpointRecorded` / `MotherlodeTriggered` /
`RewardClaimed` logs (see `src/services/game-event-listener.ts`).

| Method | Path                         | Auth | Description                                                                                                                    |
| ------ | ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/game/round/current`     | None | Latest round in `waiting` / `active` / `settling` status plus caller deployment (if `wallet=`)                                 |
| GET    | `/v1/game/round/history`     | None | Paginated list of rounds (`limit` ≤ 100, default 20; `offset` default 0) ordered newest-first                                  |
| GET    | `/v1/game/round/:id/status`  | None | Single round status plus caller deployment (if `wallet=`)                                                                      |
| GET    | `/v1/game/round/:id/players` | None | `{ roundId, playerCount, player }` — total count + caller deployment only; per-wallet data stays private                       |
| GET    | `/v1/game/round/:id/results` | None | Settled aggregate: `hitCount`, `totalHitPoints`, `tokensMinted`, `motherlodeTriggered`, `motherlodeAmount` + caller deployment |

All endpoints accept an optional `wallet` query parameter (Base58 pubkey).
When supplied the response includes the caller's `player` deployment row —
`pointsDeployed`, `result` (`pending` / `hit` / `miss` / `skipped`),
`isHit`, `rewardAmount`, `motherlodeShare`, `claimed`. Invalid round ids
(non-positive integers) return `400 Bad Request`; unknown round ids return
`404 Not Found`.

Post-F3 semantics (three-step refactor): `RoundSettled` carries the
`settle_timestamp` / `expires_at` / `refund_mode` / `total_points_deployed`
snapshot only. Per-player `is_hit` / `reward_amount` / `motherlode_share`
is written by `CheckpointRecorded` as crankers (or the player themselves)
run `checkpoint_round`. The `game-service.ts` TS port of
`compute_player_hit` / `compute_motherlode_share` / reward-amount lets the
API synthesize expected outcomes before the checkpoint instruction lands
— when `RoundSettled` fires we iterate every `PlayerDeployment` whose
`settled = false` and fill in the synthesized triple (best-effort, gated
on a stored `slot_hash`; the keeper is expected to backfill this row
out-of-band until the F6 cranker ships). `CheckpointRecorded` then
overwrites with the authoritative on-chain values and, thanks to an
`ON CONFLICT ... WHERE settled = false` gate, will not double-count the
`game_rounds.hit_count` / `tokens_minted` rollups on RPC reconnect
replays. Fixture regeneration lives under `tools/f8-fixture-gen/`.

### Protocols, Offers, Completions, Delegations, Subscriptions, Telegram, X Posts, Zealy

See route files in `src/routes/` for full details.

## Authentication

The API supports four auth methods, applied per-route:

- **Wallet** -- Ed25519 signature via `x-wallet-address` + `x-wallet-signature` headers
- **Bearer** -- JWT in `Authorization: Bearer <token>` header
- **API Key** -- Protocol API key via `x-api-key` header (hashed and matched against `protocols` table)
- **Internal** -- Shared `INTERNAL_API_KEY` via `x-api-key` for service-to-service calls

## Project Structure

```
src/
  config.ts           # Zod-validated env config
  server.ts           # Fastify app builder + entrypoint
  types/index.ts      # Shared TypeScript types and enums
  middleware/
    auth.ts           # Auth hooks (wallet, bearer, API key, internal)
    rate-limit.ts     # Rate limiting middleware
  routes/
    health.ts         # GET /healthz
    intents.ts        # Intent resolution
    points.ts         # Points balance, history, awards
    quests.ts         # Quest CRUD + progress
    offers.ts         # Protocol offers
    completions.ts    # Action completions
    delegations.ts    # Delegation management
    subscriptions.ts  # Subscription management
    protocols.ts      # Protocol registry
    telegram.ts       # Telegram bot integration
    x-post.ts         # X/Twitter post submissions
    zealy.ts          # Zealy webhook integration
  services/
    intent-resolver.ts   # NLP / rules-based intent matching
    ranking-engine.ts    # Offer ranking by trust + relevance
    verifier.ts          # Generic verification service
    tweet-verifier.ts    # Tweet content verification
    points-service.ts    # Points ledger operations
  db/
    client.ts         # pg pool + query helper
    migrate.ts        # Migration runner
    seed.ts           # Test data seeder
    migrations/       # Sequential SQL migrations (001-030)
tests/
  migrations.test.ts  # Migration tests
```

## Docker

```bash
docker compose up -d   # Starts postgres + api on :3001
```

The Dockerfile uses a multi-stage build (deps -> build -> production) with Node 22 and pnpm.

## Database

PostgreSQL 16. Migrations are plain SQL files in `src/db/migrations/`, applied in order by `migrate.ts`. Key tables: `users`, `protocols`, `campaigns`, `quests`, `quest_steps`, `quest_progress`, `point_events`, `user_balances`, `completions`, `delegations`, `subscriptions`, `telegram_users`.
