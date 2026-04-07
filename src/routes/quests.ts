import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth } from "../middleware/auth.js";
import { awardPoints } from "../services/points-service.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface QuestsQuery {
  quest_type?: string;
  status?: string;
  page?: string;
  limit?: string;
}

interface QuestParams {
  id: string;
}

interface StepParams {
  id: string;
  stepIndex: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function questRoutes(app: FastifyInstance): Promise<void> {
  /* ------ GET /quests ------ */
  app.get("/quests", async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as QuestsQuery;
    const page = Math.max(1, parseInt(qs.page ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
    );
    const offset = (page - 1) * limit;

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (qs.quest_type) {
        conditions.push(`q.quest_type = $${paramIdx++}`);
        params.push(qs.quest_type);
      }
      if (qs.status) {
        conditions.push(`q.status = $${paramIdx++}`);
        params.push(qs.status);
      } else {
        conditions.push(`q.status = 'active'`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM quests q ${whereClause}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const result = await query(
        `SELECT q.quest_id, q.created_by, p.name AS protocol_name, q.name, q.description,
                q.quest_type, q.reward_points, q.max_participants, q.start_at, q.end_at,
                q.status, q.created_at
         FROM quests q
         LEFT JOIN protocols p ON p.id = q.created_by
         ${whereClause}
         ORDER BY q.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      return reply.status(200).send({
        quests: result.rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      request.log.error(err, "Failed to list quests");
      return reply
        .status(500)
        .send({
          error: "Internal Server Error",
          message: "Failed to list quests",
        });
    }
  });

  /* ------ GET /quests/:id ------ */
  app.get(
    "/quests/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as QuestParams;

      try {
        const questResult = await query(
          `SELECT q.quest_id, q.created_by, p.name AS protocol_name, q.name, q.description,
                  q.quest_type, q.reward_points, q.max_participants, q.start_at, q.end_at,
                  q.status, q.created_at
           FROM quests q
           LEFT JOIN protocols p ON p.id = q.created_by
           WHERE q.quest_id = $1`,
          [id],
        );

        if (questResult.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Quest not found" });
        }

        const quest = questResult.rows[0] as Record<string, unknown>;

        // Include steps for composable quests
        const stepsResult = await query(
          `SELECT step_index, intent_type, protocol_id, params, points, depends_on
           FROM quest_steps
           WHERE quest_id = $1
           ORDER BY step_index ASC`,
          [id],
        );

        return reply.status(200).send({
          ...quest,
          steps: stepsResult.rows,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch quest");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch quest",
          });
      }
    },
  );

  /* ------ POST /quests/:id/join ------ */
  app.post(
    "/quests/:id/join",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as QuestParams;
      const walletAddress = request.walletAddress!;

      try {
        // Verify quest exists and is active
        const questResult = await query<{ quest_id: string; status: string }>(
          `SELECT quest_id, status FROM quests WHERE quest_id = $1`,
          [id],
        );

        if (questResult.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Quest not found" });
        }

        if (questResult.rows[0].status !== "active") {
          return reply
            .status(409)
            .send({ error: "Conflict", message: "Quest is not active" });
        }

        // Check if already joined (UNIQUE constraint on quest_id, user_wallet)
        const existing = await query<{ quest_progress_id: string }>(
          `SELECT quest_progress_id FROM quest_progress WHERE quest_id = $1 AND user_wallet = $2 LIMIT 1`,
          [id, walletAddress],
        );

        if (existing.rowCount && existing.rowCount > 0) {
          return reply.status(409).send({
            error: "Conflict",
            message: "Already joined this quest",
            progress_id: existing.rows[0].quest_progress_id,
          });
        }

        const result = await query<{
          quest_progress_id: string;
          started_at: Date;
        }>(
          `INSERT INTO quest_progress (quest_id, user_wallet)
           VALUES ($1, $2)
           RETURNING quest_progress_id, started_at`,
          [id, walletAddress],
        );

        return reply.status(201).send({
          progress_id: result.rows[0].quest_progress_id,
          quest_id: id,
          user_wallet: walletAddress,
          completed: false,
          steps_completed: [],
          started_at: result.rows[0].started_at,
        });
      } catch (err) {
        request.log.error(err, "Failed to join quest");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to join quest",
          });
      }
    },
  );

  /* ------ GET /quests/:id/progress ------ */
  app.get(
    "/quests/:id/progress",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as QuestParams;
      const walletAddress = request.walletAddress!;

      try {
        const result = await query(
          `SELECT quest_progress_id, quest_id, user_wallet, conditions_met,
                  steps_completed, bonus_awarded, completed, completed_at, started_at
           FROM quest_progress
           WHERE quest_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({
              error: "Not Found",
              message: "Quest progress not found. Join the quest first.",
            });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to fetch quest progress");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch quest progress",
          });
      }
    },
  );

  /* ------ POST /quests/:id/steps/:stepIndex/complete ------ */
  app.post(
    "/quests/:id/steps/:stepIndex/complete",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, stepIndex: stepIndexStr } = request.params as StepParams;
      const walletAddress = request.walletAddress!;
      const stepIndex = parseInt(stepIndexStr, 10);

      if (Number.isNaN(stepIndex) || stepIndex < 0) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "Invalid step index" });
      }

      try {
        // Get progress
        const progressResult = await query<{
          quest_progress_id: string;
          steps_completed: number[];
          completed: boolean;
        }>(
          `SELECT quest_progress_id, steps_completed, completed
           FROM quest_progress
           WHERE quest_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (progressResult.rowCount === 0) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Quest progress not found. Join the quest first.",
          });
        }

        const progress = progressResult.rows[0];

        if (progress.completed) {
          return reply
            .status(409)
            .send({ error: "Conflict", message: "Quest already completed" });
        }

        const stepsCompleted = progress.steps_completed ?? [];

        if (stepsCompleted.includes(stepIndex)) {
          return reply.status(409).send({
            error: "Conflict",
            message: `Step ${stepIndex} already completed`,
          });
        }

        // Verify step exists
        const stepResult = await query<{
          step_index: number;
          depends_on: number | null;
        }>(
          `SELECT step_index, depends_on FROM quest_steps WHERE quest_id = $1 AND step_index = $2`,
          [id, stepIndex],
        );

        if (stepResult.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Quest step not found" });
        }

        // Check dependency
        const step = stepResult.rows[0];
        if (
          step.depends_on !== null &&
          !stepsCompleted.includes(step.depends_on)
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message: `Step ${step.depends_on} must be completed first`,
          });
        }

        // Count total steps
        const totalStepsResult = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM quest_steps WHERE quest_id = $1`,
          [id],
        );
        const totalSteps = parseInt(totalStepsResult.rows[0].count, 10);

        const newStepsCompleted = [...stepsCompleted, stepIndex];
        const isCompleted = newStepsCompleted.length >= totalSteps;

        // Update progress — steps_completed is INTEGER[]
        await query(
          `UPDATE quest_progress
           SET steps_completed = $1,
               completed = $2,
               completed_at = $3
           WHERE quest_progress_id = $4`,
          [
            newStepsCompleted,
            isCompleted,
            isCompleted ? new Date() : null,
            progress.quest_progress_id,
          ],
        );

        // Award points on completion
        if (isCompleted) {
          const questResult = await query<{
            reward_points: string;
            created_by: string | null;
          }>(
            `SELECT reward_points, created_by FROM quests WHERE quest_id = $1`,
            [id],
          );

          if (questResult.rowCount && questResult.rowCount > 0) {
            const points = BigInt(questResult.rows[0].reward_points);
            if (points > 0n) {
              await awardPoints(
                walletAddress,
                points,
                questResult.rows[0].created_by,
                { type: "reference", key: `quest:${id}:${walletAddress}` },
                `Quest ${id} completed`,
              );
            }
          }
        }

        return reply.status(200).send({
          quest_id: id,
          step_completed: stepIndex,
          steps_completed: newStepsCompleted,
          quest_completed: isCompleted,
        });
      } catch (err) {
        request.log.error(err, "Failed to complete step");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to complete step",
          });
      }
    },
  );

  /* ------ GET /quests/my ------ */
  app.get(
    "/quests/my",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const walletAddress = request.walletAddress!;

      try {
        const result = await query(
          `SELECT qp.quest_progress_id, qp.quest_id, qp.steps_completed,
                  qp.completed, qp.started_at, qp.completed_at,
                  q.name, q.description, q.quest_type, q.reward_points,
                  q.status AS quest_status, p.name AS protocol_name
           FROM quest_progress qp
           JOIN quests q ON q.quest_id = qp.quest_id
           LEFT JOIN protocols p ON p.id = q.created_by
           WHERE qp.user_wallet = $1
           ORDER BY qp.started_at DESC`,
          [walletAddress],
        );

        return reply.status(200).send({ quests: result.rows });
      } catch (err) {
        request.log.error(err, "Failed to fetch my quests");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch my quests",
          });
      }
    },
  );
}
