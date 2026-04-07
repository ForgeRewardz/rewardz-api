import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_request: FastifyRequest, reply: FastifyReply) => {
    let dbStatus: "connected" | "disconnected" = "disconnected";

    try {
      await query("SELECT 1");
      dbStatus = "connected";
    } catch {
      // DB is down — report degraded
    }

    const status = dbStatus === "connected" ? "ok" : "degraded";

    return reply.status(200).send({
      status,
      timestamp: new Date().toISOString(),
      db: dbStatus,
    });
  });
}
