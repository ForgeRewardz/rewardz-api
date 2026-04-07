import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth } from "../middleware/auth.js";
import { verifyCompletion } from "../services/verifier.js";
import { awardPoints } from "../services/points-service.js";
import { query } from "../db/client.js";
import { config } from "../config.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface InitBody {
  protocol_id: string;
  reward_policy_id?: string;
  expected_action_url?: string;
  expected_constraints?: object;
}

interface CallbackBody {
  completion_id: string;
  signature: string;
}

interface CompletionParams {
  id: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function completionRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /completions/init ------ */
  app.post(
    "/completions/init",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as InitBody | undefined;

      if (!body?.protocol_id) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "protocol_id is required" });
      }

      const walletAddress = request.walletAddress!;
      const expectedReference = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      try {
        const result = await query<{ id: string }>(
          `INSERT INTO completions (user_wallet, protocol_id, reward_policy_id, expected_action_url, expected_constraints, expected_reference, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_signature', $7)
           RETURNING id`,
          [
            walletAddress,
            body.protocol_id,
            body.reward_policy_id ?? null,
            body.expected_action_url ?? null,
            body.expected_constraints
              ? JSON.stringify(body.expected_constraints)
              : null,
            expectedReference,
            expiresAt,
          ],
        );

        return reply.status(201).send({
          completion_id: result.rows[0].id,
          expected_reference: expectedReference,
          expires_at: expiresAt.toISOString(),
        });
      } catch (err) {
        request.log.error(err, "Failed to init completion");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to init completion",
        });
      }
    },
  );

  /* ------ POST /completions/callback ------ */
  app.post(
    "/completions/callback",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CallbackBody | undefined;

      if (!body?.completion_id || !body.signature) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "completion_id and signature are required",
        });
      }

      const walletAddress = request.walletAddress!;

      try {
        // Fetch completion
        const compResult = await query<{
          id: string;
          user_wallet: string;
          expected_reference: string;
          status: string;
          protocol_id: string;
        }>(
          `SELECT id, user_wallet, expected_reference, status, protocol_id
           FROM completions
           WHERE id = $1`,
          [body.completion_id],
        );

        if (compResult.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Completion not found" });
        }

        const comp = compResult.rows[0];

        if (comp.user_wallet !== walletAddress) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Wallet mismatch" });
        }

        if (comp.status !== "awaiting_signature") {
          return reply.status(409).send({
            error: "Conflict",
            message: `Completion is already in status: ${comp.status}`,
          });
        }

        // Update to awaiting_chain_verification
        await query(
          `UPDATE completions SET signature = $1, status = 'awaiting_chain_verification'
           WHERE id = $2`,
          [body.signature, body.completion_id],
        );

        // Fire-and-forget async chain verification.
        // Capture values to avoid holding request-scoped references.
        const completionId = body.completion_id;
        const txSignature = body.signature;
        const expectedRef = comp.expected_reference;
        const protocolId = comp.protocol_id;

        void (async () => {
          try {
            const verification = await verifyCompletion(
              txSignature,
              walletAddress,
              expectedRef,
              config.SOLANA_RPC_URL,
            );

            if (verification.verified) {
              await query(
                `UPDATE completions SET status = 'awarded', verified_at = NOW() WHERE id = $1`,
                [completionId],
              );

              // Award points from the reward policy if exists
              const policyResult = await query<{ points: string }>(
                `SELECT rp.points
                 FROM reward_policies rp
                 JOIN completions c ON c.reward_policy_id = rp.id
                 WHERE c.id = $1`,
                [completionId],
              );

              if (policyResult.rowCount && policyResult.rowCount > 0) {
                const points = BigInt(policyResult.rows[0].points);
                await awardPoints(
                  walletAddress,
                  points,
                  protocolId,
                  { type: "completion", key: completionId },
                  "Completion verified",
                );
              }
            } else {
              await query(
                `UPDATE completions SET status = 'rejected', rejection_reason = $1 WHERE id = $2`,
                [verification.reason ?? "Verification failed", completionId],
              );
            }
          } catch (err) {
            // Log but don't crash — this is fire-and-forget
            console.error("Async verification failed:", err);
          }
        })();

        return reply.status(200).send({
          completion_id: body.completion_id,
          status: "awaiting_chain_verification",
        });
      } catch (err) {
        request.log.error(err, "Completion callback failed");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Completion callback failed",
        });
      }
    },
  );

  /* ------ GET /completions/:id ------ */
  app.get(
    "/completions/:id",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as CompletionParams;
      const walletAddress = request.walletAddress!;

      try {
        const result = await query(
          `SELECT id, user_wallet, protocol_id, reward_policy_id, expected_action_url,
                  expected_constraints, expected_reference, signature, status,
                  rejection_reason, points_awarded, verified_at, expires_at, created_at
           FROM completions
           WHERE id = $1`,
          [id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Completion not found" });
        }

        const comp = result.rows[0] as Record<string, unknown>;

        if (comp.user_wallet !== walletAddress) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Wallet mismatch" });
        }

        return reply.status(200).send(comp);
      } catch (err) {
        request.log.error(err, "Failed to fetch completion");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch completion",
        });
      }
    },
  );
}
