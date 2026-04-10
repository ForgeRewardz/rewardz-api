/**
 * Fastify test-app helper. Wraps `buildApp()` from `../../src/server.js`
 * so integration tests can call `app.inject({...})` without binding to
 * an HTTP port.
 *
 * Usage:
 *
 *     import { createTestApp, authHeader } from "./helpers/test-app.js";
 *
 *     let app: Awaited<ReturnType<typeof createTestApp>>;
 *
 *     beforeAll(async () => {
 *       app = await createTestApp();
 *     });
 *
 *     afterAll(async () => {
 *       await app.close();
 *     });
 *
 *     it("rejects unauthenticated GET /v1/protected", async () => {
 *       const res = await app.inject({
 *         method: "GET",
 *         url: "/v1/protected",
 *         headers: authHeader("11111111111111111111111111111111"),
 *       });
 *       expect(res.statusCode).toBe(401);
 *     });
 *
 * The auth header helpers mint short-lived JWTs using the same
 * `JWT_SECRET` the API reads at startup. Callers that need an admin
 * wallet should use `adminAuthHeader` — the list of admin wallets will
 * be wired up by Session 2 via `ADMIN_WALLETS`. Until then the helper
 * mints the same shape of token as `authHeader`; tests that rely on
 * admin-vs-user distinction will need to wait for the middleware work.
 */

import jwt from "jsonwebtoken";
import { buildApp } from "../../src/server.js";
import { config } from "../../src/config.js";

export type TestApp = ReturnType<typeof buildApp>;

/**
 * Build a fresh Fastify instance. Does NOT start an HTTP listener —
 * use `app.inject({...})` to exercise routes.
 *
 * The caller is responsible for calling `app.close()` in an
 * `afterAll` hook so the pg pool and any background timers shut down.
 */
export async function createTestApp(): Promise<TestApp> {
  const app = buildApp();
  // Ensure all plugins are registered before the first inject call.
  await app.ready();
  return app;
}

interface JwtClaims {
  wallet_address: string;
  iat?: number;
  exp?: number;
  jti?: string;
  aud?: string;
  iss?: string;
}

interface MintOptions {
  /** Seconds until expiry. Default 900 (15 min). */
  expiresInSeconds?: number;
  /** Override JWT id (jti). Default: crypto.randomUUID(). */
  jti?: string;
  /** Audience claim. Default matches Session 2 plan value. */
  audience?: string;
  /** Issuer claim. Default matches Session 2 plan value. */
  issuer?: string;
}

function mintJwt(walletAddress: string, options: MintOptions = {}): string {
  const payload: JwtClaims = {
    wallet_address: walletAddress,
  };
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: options.expiresInSeconds ?? 900,
    jwtid: options.jti ?? crypto.randomUUID(),
    audience: options.audience ?? "rewardz-api",
    issuer: options.issuer ?? "rewardz-console",
  });
}

/**
 * Build a `{ Authorization: "Bearer <jwt>" }` header for a regular
 * wallet. Used by tests that exercise `requireBearerAuth`-protected
 * routes.
 */
export function authHeader(
  walletAddress: string,
  options: MintOptions = {},
): { authorization: string } {
  return {
    authorization: `Bearer ${mintJwt(walletAddress, options)}`,
  };
}

/**
 * Build a `{ Authorization: "Bearer <jwt>" }` header for an admin
 * wallet. Currently identical in shape to `authHeader` — the
 * admin-vs-user gating will be enforced in Session 2 once
 * `requireAdminAuth` and the `ADMIN_WALLETS` config land. The separate
 * function exists so tests can declare intent up-front and will
 * automatically pick up the stricter behaviour when the middleware
 * ships.
 */
export function adminAuthHeader(
  walletAddress: string,
  options: MintOptions = {},
): { authorization: string } {
  return authHeader(walletAddress, options);
}
