/**
 * Fastify test-app helper. Wraps `buildApp()` from `../../src/server.js`
 * so integration tests can call `app.inject({...})` without binding to
 * an HTTP port.
 *
 * Usage:
 *
 *     import { createTestApp, authHeader, type TestApp } from "./helpers/test-app.js";
 *
 *     let app: TestApp;
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
 * `JWT_SECRET`, `JWT_AUDIENCE`, and `JWT_ISSUER` the API verifies with,
 * so tokens they produce pass `requireBearerAuth` without fuss. For
 * `requireAdminAuth`-protected routes, use `adminAuthHeader` and make
 * sure the wallet is in `ADMIN_WALLETS` before the test runs.
 */

import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { buildApp } from "../../src/server.js";
import { config } from "../../src/config.js";
import { JWT_AUDIENCE, JWT_ISSUER } from "../../src/middleware/auth.js";

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
  /** Seconds until expiry. Default 900 (15 min), matching signProtocolSessionJWT. */
  expiresInSeconds?: number;
  /** Override JWT id (jti). Default: randomUUID(). */
  jti?: string;
  /** Audience claim. Defaults to the shared JWT_AUDIENCE const. */
  audience?: string;
  /** Issuer claim. Defaults to the shared JWT_ISSUER const. */
  issuer?: string;
}

function mintJwt(walletAddress: string, options: MintOptions = {}): string {
  const payload: JwtClaims = {
    wallet_address: walletAddress,
  };
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: options.expiresInSeconds ?? 900,
    jwtid: options.jti ?? randomUUID(),
    audience: options.audience ?? JWT_AUDIENCE,
    issuer: options.issuer ?? JWT_ISSUER,
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
 * wallet. Mints the same JWT shape as `authHeader` — the admin gate
 * lives in `requireAdminAuth`, which checks membership in the
 * `ADMIN_WALLETS` env allowlist at request time.
 *
 * **Test-environment contract:** the caller must ensure the wallet it
 * passes is present in `ADMIN_WALLETS` before the test runs, otherwise
 * `requireAdminAuth` will (correctly) return 403. The simplest pattern
 * is to `process.env.ADMIN_WALLETS = wallet` inside a `beforeEach` and
 * restore it in `afterEach` — but note that `config.ts` reads the env
 * at import time, so tests that depend on ADMIN_WALLETS should either
 * set the env before importing the app or reload config per test.
 */
export function adminAuthHeader(
  walletAddress: string,
  options: MintOptions = {},
): { authorization: string } {
  return authHeader(walletAddress, options);
}
