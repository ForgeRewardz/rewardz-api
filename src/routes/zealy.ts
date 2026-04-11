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

      // Resolve the owning protocol from the webhook secret. When the
      // ZEALY_DEFAULT_SECRET matches we have no per-protocol binding, so
      // `protocolId` stays null and the season-score hooks inside
      // awardPoints become a no-op (graceful degrade — see points-service
      // task 14). When a per-protocol api_key_hash matches we capture
      // the id and thread it through so leaderboards update for that
      // protocol.
      let protocolId: string | null = null;

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
          if ((protocolResult.rowCount ?? 0) > 0) {
            secretValid = true;
            protocolId = protocolResult.rows[0].id;
          }
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

        // Award points with idempotency on webhook event ID. When
        // protocolId is null (ZEALY_DEFAULT_SECRET path) the season-score
        // hook inside awardPoints skips silently — no leaderboard rollups
        // are possible without a protocol binding.
        await awardPoints(
          wallet,
          defaultPoints,
          protocolId,
          { type: "reference", key: `zealy:${body.id}` },
          `Zealy quest ${body.data.questId} completed`,
          "webhook",
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
