import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth } from "../middleware/auth.js";
import { parseTweetUrl } from "../services/tweet-verifier.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface SubmitBody {
  tweet_url: string;
  wallet_address: string;
  protocol_id?: string;
  rule_id?: string;
}

interface StatusParams {
  submission_id: string;
}

interface SubmissionsQuery {
  wallet: string;
  limit?: string;
  offset?: string;
}

interface RulesQuery {
  protocolId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function xPostRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /tweets/submit ------ */
  app.post(
    "/tweets/submit",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as SubmitBody | undefined;

      if (!body?.tweet_url || !body.wallet_address) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "tweet_url and wallet_address are required",
          });
      }

      const tweetId = parseTweetUrl(body.tweet_url);
      if (!tweetId) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "Invalid tweet URL format" });
      }

      try {
        // Check for duplicate (UNIQUE on tweet_id, user_wallet)
        const dupCheck = await query<{ id: string }>(
          `SELECT id FROM tweet_submissions WHERE tweet_id = $1 AND user_wallet = $2 LIMIT 1`,
          [tweetId, body.wallet_address],
        );

        if (dupCheck.rowCount && dupCheck.rowCount > 0) {
          return reply.status(409).send({
            error: "Conflict",
            message: "This tweet has already been submitted by this wallet",
            submission_id: dupCheck.rows[0].id,
          });
        }

        const result = await query<{ id: string }>(
          `INSERT INTO tweet_submissions (tweet_id, tweet_url, user_wallet, protocol_id, rule_id, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING id`,
          [
            tweetId,
            body.tweet_url,
            body.wallet_address,
            body.protocol_id ?? null,
            body.rule_id ?? null,
          ],
        );

        return reply.status(201).send({
          submission_id: result.rows[0].id,
          status: "pending",
        });
      } catch (err) {
        request.log.error(err, "Failed to submit tweet");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to submit tweet",
          });
      }
    },
  );

  /* ------ GET /tweets/status/:submission_id ------ */
  app.get(
    "/tweets/status/:submission_id",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { submission_id } = request.params as StatusParams;

      try {
        const result = await query(
          `SELECT id, tweet_id, tweet_url, user_wallet, protocol_id, rule_id,
                  status, points_awarded, submitted_at
           FROM tweet_submissions
           WHERE id = $1`,
          [submission_id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Submission not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to fetch tweet status");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch tweet status",
          });
      }
    },
  );

  /* ------ GET /tweets/submissions ------ */
  app.get(
    "/tweets/submissions",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as SubmissionsQuery;

      if (!qs.wallet) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "wallet query parameter is required",
          });
      }

      const limit = Math.min(
        100,
        Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
      );
      const offset = Math.max(0, parseInt(qs.offset ?? "0", 10) || 0);

      try {
        const result = await query(
          `SELECT id, tweet_id, tweet_url, user_wallet, protocol_id, rule_id,
                  status, points_awarded, submitted_at
           FROM tweet_submissions
           WHERE user_wallet = $1
           ORDER BY submitted_at DESC
           LIMIT $2 OFFSET $3`,
          [qs.wallet, limit, offset],
        );

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM tweet_submissions WHERE user_wallet = $1`,
          [qs.wallet],
        );
        const total = parseInt(countResult.rows[0].count, 10);

        return reply.status(200).send({
          submissions: result.rows,
          pagination: { limit, offset, total },
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch submissions");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch submissions",
          });
      }
    },
  );

  /* ------ GET /tweets/rules ------ */
  app.get(
    "/tweets/rules",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { protocolId } = request.query as RulesQuery;

      try {
        let sql = `SELECT id, protocol_id, label, base_points, bonus_per_like, bonus_per_retweet,
                           required_handles, required_hashtags, required_cashtags,
                           all_required, is_active, max_submissions_per_wallet, created_at
                    FROM tweet_verification_rules
                    WHERE is_active = true`;
        const params: unknown[] = [];

        if (protocolId) {
          sql += ` AND protocol_id = $1`;
          params.push(protocolId);
        }

        sql += ` ORDER BY created_at DESC`;

        const result = await query(sql, params);

        return reply.status(200).send({ rules: result.rows });
      } catch (err) {
        request.log.error(err, "Failed to fetch tweet rules");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch tweet rules",
          });
      }
    },
  );
}
