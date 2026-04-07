import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { intentRoutes } from "./routes/intents.js";
import { completionRoutes } from "./routes/completions.js";
import { offerRoutes } from "./routes/offers.js";
import { pointRoutes } from "./routes/points.js";
import { xPostRoutes } from "./routes/x-post.js";
import { zealyRoutes } from "./routes/zealy.js";
import { telegramRoutes } from "./routes/telegram.js";
import { delegationRoutes } from "./routes/delegations.js";
import { protocolRoutes } from "./routes/protocols.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { questRoutes } from "./routes/quests.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  const allowedOrigins = config.ALLOWED_ORIGINS
    ? config.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"];
  app.register(cors, { origin: allowedOrigins });

  // Route plugins with /v1 prefix
  app.register(intentRoutes, { prefix: "/v1" });
  app.register(completionRoutes, { prefix: "/v1" });
  app.register(offerRoutes, { prefix: "/v1" });
  app.register(pointRoutes, { prefix: "/v1" });
  app.register(xPostRoutes, { prefix: "/v1" });
  app.register(zealyRoutes, { prefix: "/v1" });
  app.register(telegramRoutes, { prefix: "/v1" });
  app.register(delegationRoutes, { prefix: "/v1" });
  app.register(protocolRoutes, { prefix: "/v1" });
  app.register(subscriptionRoutes, { prefix: "/v1" });
  app.register(questRoutes, { prefix: "/v1" });

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
