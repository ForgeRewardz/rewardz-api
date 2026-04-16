import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { config } from "../config.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { BASE58_PUBKEY } from "../types/solana.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

// Pragmatic RFC-5322-subset: one `@`, something non-trivial either side,
// no whitespace, ≤254 chars (the RFC path-limit). We don't try to be
// authoritative about email syntax here — the downstream verification
// loop (airdrop delivery) is what ultimately decides if an address is
// reachable.
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,64}$/;

const signupBodySchema = z.object({
  wallet: z
    .string()
    .regex(BASE58_PUBKEY, "wallet must be a valid base58 Solana pubkey"),
  email: z
    .string()
    .max(254, "email must be ≤254 characters")
    .regex(EMAIL, "email must look like a valid address"),
});

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function airdropRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /airdrop/signup
   *
   * Stores an email tied to a wallet for airdrop notification. The
   * email is encrypted at rest via pgcrypto `pgp_sym_encrypt(email,
   * AIRDROP_EMAIL_KEY)` — plaintext never touches disk. Migration 041
   * enabled pgcrypto and created `airdrop_signups(wallet UNIQUE,
   * email_encrypted BYTEA, created_at)`.
   *
   * Idempotency: UNIQUE(wallet) + ON CONFLICT DO UPDATE so re-submitting
   * with a corrected email overwrites. This is "last write wins" and
   * deliberate — a user changing their email before distribution is
   * the expected case.
   *
   * Response:
   *   200 { ok: true, updated: boolean } — updated=false means new row
   *   400 { error } — malformed body
   *   503 { error } — AIRDROP_EMAIL_KEY not configured (fail closed,
   *        never silently store plaintext)
   */
  app.post(
    "/airdrop/signup",
    {
      // Each call is CPU-bound (pgp_sym_encrypt) and the UNIQUE(wallet)
      // upsert means a large-scale attacker can otherwise fill the
      // signup table with junk emails. 10/min/IP is plenty for a
      // real user filling out one email form.
      preHandler: [rateLimit(60_000, 10)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.AIRDROP_EMAIL_KEY) {
        // Fail closed: an operator who forgot to set AIRDROP_EMAIL_KEY
        // should see a loud error, not find out later that 10k emails
        // are sitting unencrypted in the DB.
        request.log.error("AIRDROP_EMAIL_KEY is not configured");
        return reply.status(503).send({
          error: "Service Unavailable",
          message: "Airdrop signup is not configured on this server",
        });
      }

      const parse = signupBodySchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      const { wallet, email } = parse.data;

      try {
        // pgp_sym_encrypt runs server-side so the plaintext email
        // travels only as a bind parameter over the pg wire protocol
        // (TLS in prod) and never lands on disk as plaintext. The
        // key travels the same way — not great long-term but matches
        // the scope for R6 (rotation script ships in this task).
        //
        // xmax = 0 marks the conflict branch as a pure insert; any
        // non-zero xmax means the row existed and DO UPDATE fired.
        // (Standard Postgres idiom for detecting which branch ran.)
        const result = await query<{ was_update: boolean }>(
          `INSERT INTO airdrop_signups (wallet, email_encrypted)
           VALUES ($1, pgp_sym_encrypt($2, $3))
           ON CONFLICT (wallet)
           DO UPDATE SET email_encrypted = EXCLUDED.email_encrypted
           RETURNING (xmax <> 0) AS was_update`,
          [wallet, email, config.AIRDROP_EMAIL_KEY],
        );

        const updated = result.rows[0]?.was_update ?? false;
        return reply.status(200).send({ ok: true, updated });
      } catch (err) {
        // Do not echo the error detail to the client — it may include
        // fragments of the bind params (email, key) in some pg error
        // shapes. Log server-side only.
        request.log.error(err, "Failed to store airdrop signup");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to store airdrop signup",
        });
      }
    },
  );
}
