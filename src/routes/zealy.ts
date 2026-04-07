import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { awardPoints } from "../services/points-service.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface ZealyPayload {
  id: string;
  type: string;
  data: {
    userId: string;
    questId: string;
    walletAddress?: string;
    [key: string]: unknown;
  };
  time: string;
  secret: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function zealyRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/zealy",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify User-Agent header
      const userAgent = request.headers["user-agent"];
      if (userAgent !== "Zealy-Webhook") {
        return reply
          .status(401)
          .send({ error: "Unauthorized", message: "Invalid User-Agent" });
      }

      const body = request.body as ZealyPayload | undefined;

      if (!body?.id || !body.type || !body.data || !body.secret) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "Invalid Zealy webhook payload",
          });
      }

      try {
        // Verify webhook secret (timing-safe comparison)
        let secretValid = false;

        if (config.ZEALY_DEFAULT_SECRET) {
          secretValid = timingSafeCompare(
            body.secret,
            config.ZEALY_DEFAULT_SECRET,
          );
        }

        // Also check protocol-specific secrets stored in protocols table
        if (!secretValid) {
          const protocolResult = await query<{ id: string }>(
            `SELECT id FROM protocols
             WHERE status = 'active'
             AND api_key_hash = $1`,
            [crypto.createHash("sha256").update(body.secret).digest("hex")],
          );
          secretValid = (protocolResult.rowCount ?? 0) > 0;
        }

        if (!secretValid) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Invalid webhook secret" });
        }

        // Resolve user wallet from payload or lookup
        let wallet = body.data.walletAddress;

        if (!wallet) {
          // Try telegram_users mapping as fallback
          const userResult = await query<{ wallet_address: string }>(
            `SELECT wallet_address FROM telegram_users WHERE telegram_id = $1 LIMIT 1`,
            [body.data.userId],
          );

          if (userResult.rowCount === 0) {
            // User not linked — acknowledge but don't award
            return reply
              .status(200)
              .send({
                status: "ok",
                message: "User not linked, no wallet found",
              });
          }

          wallet = userResult.rows[0].wallet_address;
        }

        // Default points for Zealy quest completions
        const defaultPoints = BigInt(100);

        // Award points with idempotency on webhook event ID
        await awardPoints(
          wallet,
          defaultPoints,
          null,
          { type: "reference", key: `zealy:${body.id}` },
          `Zealy quest ${body.data.questId} completed`,
        );

        return reply.status(200).send({ status: "ok" });
      } catch (err) {
        request.log.error(err, "Zealy webhook processing failed");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Webhook processing failed",
          });
      }
    },
  );
}
