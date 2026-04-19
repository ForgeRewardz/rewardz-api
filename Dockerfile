# syntax=docker/dockerfile:1.6
# ============================================================================
# api Dockerfile
# ----------------------------------------------------------------------------
# Build context: mobileSpecs/ root (set in docker-compose.yml).
# Reason: api/package.json declares two file: deps that live OUTSIDE api/:
#     "@rewardz/sdk":   "file:../sdk/packages/sdk"
#     "@rewardz/types": "file:../sdk/packages/types"
# A per-service build context (./api) cannot see /sdk, so pnpm install
# fails with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND. Lifting the context to
# the monorepo root lets us COPY the sibling sdk packages into the image.
#
# Prerequisite: sdk/packages/{sdk,types}/dist/ must exist on the host
# before `docker build`. setup.sh step 6 (`pnpm codama`) regenerates them;
# `bootstrap-local.sh` sequences setup.sh BEFORE this image is built.
# ============================================================================

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Stage 1: install deps ──────────────────────────────────────────────────
# Stage the sibling sdk packages at the same relative path the api expects
# (../sdk/packages/{sdk,types}). We only copy package.json + dist/ — the
# api consumes the built outputs, not source.
FROM base AS deps
WORKDIR /sdk/packages/sdk
COPY sdk/packages/sdk/package.json ./
COPY sdk/packages/sdk/dist ./dist
WORKDIR /sdk/packages/types
COPY sdk/packages/types/package.json ./
COPY sdk/packages/types/dist ./dist

WORKDIR /app
COPY api/package.json api/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# ── Stage 2: build ─────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY api/tsconfig.json ./
COPY api/src ./src
RUN pnpm build

# ── Stage 3: production runtime ────────────────────────────────────────────
# pnpm `file:` deps create symlinks in node_modules pointing at the source
# location, so /sdk/packages/{sdk,types} must also exist in the runtime
# image — copy them again here.
FROM base AS production
ENV NODE_ENV=production

WORKDIR /sdk/packages/sdk
COPY sdk/packages/sdk/package.json ./
COPY sdk/packages/sdk/dist ./dist
WORKDIR /sdk/packages/types
COPY sdk/packages/types/package.json ./
COPY sdk/packages/types/dist ./dist

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/db/migrations
# Seed SQL ships alongside the compiled app so an operator can apply it
# with `docker exec -i <pg> psql … < /app/scripts/<seed>.sql`. The
# wallet-connect bonus campaign lives in scripts/seed-rewardz-protocol.sql;
# without this the `/v1/campaigns/wallet-connect/claim` endpoint returns
# `{awarded: false, reason: "campaign_not_seeded"}` on a fresh database.
COPY api/scripts ./scripts
COPY api/package.json ./

EXPOSE 3001
CMD ["node", "dist/server.js"]
