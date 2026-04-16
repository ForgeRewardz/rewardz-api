import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { wireAuthSessionRevocation } from "./services/auth-sessions.js";
import { corsActionsPlugin } from "./middleware/cors-actions.js";
import { authRoutes } from "./routes/auth.js";
import { intentRoutes } from "./routes/intents.js";
import { completionRoutes } from "./routes/completions.js";
import { offerRoutes } from "./routes/offers.js";
import { pointRoutes } from "./routes/points.js";
import { gameRoutes } from "./routes/game.js";
import { xPostRoutes } from "./routes/x-post.js";
import { zealyRoutes } from "./routes/zealy.js";
import { telegramRoutes } from "./routes/telegram.js";
import { delegationRoutes } from "./routes/delegations.js";
import { protocolRoutes } from "./routes/protocols.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { questRoutes } from "./routes/quests.js";
import { leaderboardRoutes } from "./routes/leaderboards.js";
import { adminRoutes } from "./routes/admin.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { referralRoutes } from "./routes/referrals.js";
import { airdropRoutes } from "./routes/airdrop.js";
import { leagueLeaderboardRoutes } from "./routes/leaderboard.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { idlUploadRoutes } from "./routes/idl-upload.js";
import { blinksPublishRoutes } from "./routes/blinks-publish.js";
import { blinksRuntimeRoutes } from "./routes/blinks-runtime.js";
import { blinksUserStakeRoutes } from "./routes/blinks-user-stake.js";
import { blinksCreateRentalRoutes } from "./routes/blinks-create-rental.js";
import { actionsJsonRoutes } from "./routes/actions-json.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  // Wire the real DB-backed jti revocation check into requireBearerAuth
  // BEFORE any routes register. This is idempotent and safe to call on
  // every buildApp() because it just reassigns a module-level function
  // reference — tests that rebuild the app between cases still share
  // the one true implementation. Plan task 38 + plan task 10 discipline.
  wireAuthSessionRevocation();

  const allowedOrigins = config.ALLOWED_ORIGINS
    ? config.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"];

  // CORS exemption for Solana Actions routes (Klaus A5):
  // `/v1/blinks/*` and `/actions.json` are hit by dial.to (which
  // sends a `null` / `https://dial.to` origin and expects a fully
  // permissive ACTIONS_CORS_HEADERS set including
  // `Access-Control-Allow-Private-Network: true`). The global CORS
  // allowlist above is scoped to the protocol-console origins and
  // would reject dial.to with a plain 403, so we short-circuit the
  // @fastify/cors plugin for blink paths and let the custom
  // `cors-actions` middleware handle them instead.
  //
  // Mechanism: a `delegator` function returns a per-request CORS
  // config. For blink paths we return `{ preflight: false,
  // hideOptionsRoute: false, origin: false }`, which tells
  // @fastify/cors to emit no headers and not intercept OPTIONS —
  // leaving both to the cors-actions onRequest hook registered
  // below. For every other path we return the original allowlist.
  const isBlinkPath = (url: string): boolean =>
    url.startsWith("/v1/blinks") || url === "/actions.json";
  app.register(cors, {
    delegator: (req, cb) => {
      if (isBlinkPath(req.url)) {
        cb(null, { origin: false, preflight: false });
        return;
      }
      cb(null, { origin: allowedOrigins });
    },
  });

  // corsActionsPlugin attaches ACTIONS_CORS_HEADERS (including
  // Access-Control-Allow-Private-Network: true) to every /v1/blinks/*
  // and /actions.json response, and short-circuits OPTIONS preflight
  // with a 204. Must register AFTER the global cors plugin so the
  // onRequest hook runs after fastify has a chance to dispatch the
  // delegator, but BEFORE the blink route plugins so their registered
  // OPTIONS routes inherit the header set on 204 returns.
  app.register(corsActionsPlugin);

  // Route plugins with /v1 prefix
  //
  // NOTE FOR H2 (campaigns): `/v1/protocols/:id/*` routes inside
  // `protocolRoutes` opt into `requireBearerAuth + requireProtocolOwner`
  // at their own `preHandler` — the new `POST /v1/protocols/:id/campaigns`
  // route you're adding should do the same. Do NOT register a parent-
  // scope auth hook here that would double-gate, and do NOT gate
  // `POST /v1/protocols/register` (that stays public via the legacy
  // wallet-header auth so new protocols can onboard without a JWT).
  app.register(authRoutes, { prefix: "/v1" });
  app.register(intentRoutes, { prefix: "/v1" });
  app.register(completionRoutes, { prefix: "/v1" });
  app.register(offerRoutes, { prefix: "/v1" });
  app.register(pointRoutes, { prefix: "/v1" });
  app.register(gameRoutes, { prefix: "/v1" });
  app.register(xPostRoutes, { prefix: "/v1" });
  app.register(zealyRoutes, { prefix: "/v1" });
  app.register(telegramRoutes, { prefix: "/v1" });
  app.register(delegationRoutes, { prefix: "/v1" });
  app.register(protocolRoutes, { prefix: "/v1" });
  app.register(subscriptionRoutes, { prefix: "/v1" });
  app.register(questRoutes, { prefix: "/v1" });
  app.register(leaderboardRoutes, { prefix: "/v1" });
  app.register(adminRoutes, { prefix: "/v1" });
  app.register(campaignRoutes, { prefix: "/v1" });
  app.register(referralRoutes, { prefix: "/v1" });
  app.register(airdropRoutes, { prefix: "/v1" });
  app.register(leagueLeaderboardRoutes, { prefix: "/v1" });
  app.register(discoveryRoutes, { prefix: "/v1" });

  // §15G IDL + blinks route families. idlUploadRoutes and
  // blinksPublishRoutes are authenticated (requireBearerAuth +
  // requireProtocolOwner applied per-route). blinksRuntimeRoutes and
  // actionsJsonRoutes are public — their CORS headers come from the
  // corsActionsPlugin onRequest hook registered above.
  app.register(idlUploadRoutes, { prefix: "/v1" });
  app.register(blinksPublishRoutes, { prefix: "/v1" });
  app.register(blinksUserStakeRoutes, { prefix: "/v1" });
  app.register(blinksRuntimeRoutes, { prefix: "/v1" });
  // Hand-curated user-facing `create_rental` Blink (plan task 42).
  // Lives alongside the generic manifest-driven runtime because its
  // parameter labels (duration / maxFee) are curated rather than
  // auto-generated from the IDL.
  app.register(blinksCreateRentalRoutes, { prefix: "/v1" });
  app.register(actionsJsonRoutes);

  // Health check at root (no prefix)
  app.register(healthRoutes);

  return app;
}

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    console.log(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start if run directly (not imported for tests)
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isDirectRun) {
  main();
}
