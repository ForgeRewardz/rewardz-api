import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { BASE58_PUBKEY } from "../types/solana.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Referral codes are generated server-side (see `generateReferralCode`
 * in routes/protocols.ts): 6 chars from the Crockford-ish base32
 * alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. The regex here is
 * deliberately permissive (any case, any 4..16 base58-ish chars) so
 * that a legacy slug-style code is still accepted if one is ever
 * minted by a different path; the actual authoritative check is the
 * SELECT against `protocols.referral_code`, which is UNIQUE.
 */
const REFERRAL_CODE = /^[A-Za-z0-9]{4,16}$/;

const attributeBodySchema = z.object({
  wallet: z
    .string()
    .regex(BASE58_PUBKEY, "wallet must be a valid base58 Solana pubkey"),
  code: z
    .string()
    .regex(REFERRAL_CODE, "code must be 4..16 alphanumeric characters"),
});

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function referralRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /referrals/attribute
   *
   * First-wins idempotent attribution. The `referrals` table has a
   * UNIQUE(wallet) constraint (migration 041), so `INSERT ... ON
   * CONFLICT (wallet) DO NOTHING` gives us first-wins for free: the
   * first referral to attach to a wallet sticks, every subsequent
   * call for the same wallet is a no-op.
   *
   * Intentionally unauthenticated — mini-app calls this from the
   * browser when a wallet connects after a `?r=code` deep link, and
   * we don't want to gate attribution on a signed message. The wallet
   * is not trust-sensitive here: the worst a bad actor can do is
   * attribute a wallet THEY control to a protocol that isn't theirs,
   * which doesn't earn them anything and just pins that wallet out
   * of future attribution.
   *
   * Response:
   *   200 { attributed: true,  protocolId, referralCode } — first win for this wallet
   *   200 { attributed: false, protocolId, referralCode } — wallet previously attributed
   *   404 { error } — unknown referral code
   *   400 { error } — malformed body
   */
  app.post(
    "/referrals/attribute",
    {
      // Unauthenticated endpoint — blunt both (a) referral-code
      // enumeration across the ~30^6 keyspace and (b) wallet-pinning
      // where an attacker races a victim's legitimate attribution
      // (first-wins is irreversible). 20/min/IP is generous for a
      // real mini-app that calls this once per wallet-connect.
      preHandler: [rateLimit(60_000, 20)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = attributeBodySchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      const { wallet, code } = parse.data;

      try {
        // Resolve the code → protocol. Case-sensitive: codes are
        // uppercase by generator but we accept mixed-case input and
        // uppercase server-side so `aX9Pfq` and `AX9PFQ` map to the
        // same row. The UNIQUE index on referral_code makes this a
        // single-row lookup.
        const codeUpper = code.toUpperCase();
        const protoRes = await query<{ id: string; referral_code: string }>(
          `SELECT id, referral_code
             FROM protocols
            WHERE referral_code = $1
            LIMIT 1`,
          [codeUpper],
        );
        if (protoRes.rowCount === 0) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Referral code not recognised",
          });
        }
        const { id: protocolId, referral_code: referralCode } =
          protoRes.rows[0];

        // Atomic first-wins. RETURNING on the conflict branch yields
        // zero rows, so we read back the prior attribution to tell
        // the caller which protocol owns this wallet. The second
        // SELECT only runs on the conflict path so the happy path
        // stays at one round-trip.
        const inserted = await query<{ id: string }>(
          `INSERT INTO referrals (wallet, protocol_id, referral_code)
           VALUES ($1, $2, $3)
           ON CONFLICT (wallet) DO NOTHING
           RETURNING id::text AS id`,
          [wallet, protocolId, referralCode],
        );

        if ((inserted.rowCount ?? 0) > 0) {
          return reply.status(200).send({
            attributed: true,
            protocolId,
            referralCode,
          });
        }

        const existing = await query<{
          protocol_id: string;
          referral_code: string;
        }>(
          `SELECT protocol_id, referral_code
             FROM referrals
            WHERE wallet = $1
            LIMIT 1`,
          [wallet],
        );
        if (existing.rowCount === 0) {
          // Defensively: conflict fired but row is gone. Should be
          // impossible under the single UNIQUE constraint; treat as
          // an internal error rather than lying to the caller.
          request.log.error(
            { wallet },
            "Referral conflict without existing row",
          );
          return reply.status(500).send({
            error: "Internal Server Error",
            message: "Attribution lookup failed",
          });
        }
        return reply.status(200).send({
          attributed: false,
          protocolId: existing.rows[0].protocol_id,
          referralCode: existing.rows[0].referral_code,
        });
      } catch (err) {
        request.log.error(err, "Failed to attribute referral");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to attribute referral",
        });
      }
    },
  );
}
