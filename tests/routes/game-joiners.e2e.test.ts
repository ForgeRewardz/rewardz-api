process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-game-joiners-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-game-joiners-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gameEvents } from "../../src/services/game-event-listener.js";
import type { ParsedGameEvent } from "../../src/services/game-service.js";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

const SKIP = !process.env.TEST_DATABASE_URL;

const WALLET_FULL = "ExampleWalletAddress12345678901234567890ab";
const EXPECTED_SUFFIX = `${WALLET_FULL.slice(0, 3)}…${WALLET_FULL.slice(-2)}`;

// Minimal SSE consumer: opens a connection against a listening Fastify
// instance and returns a helper that resolves on the next `event: joined`
// frame (or times out). Kept inline because the other route tests all use
// `app.inject(...)`, which buffers the full response and can't observe a
// streaming endpoint.
interface SseClient {
  close(): void;
  waitForJoined(timeoutMs?: number): Promise<{ raw: string; data: unknown }>;
  frames: string[];
  res: http.IncomingMessage;
}

function openSseClient(port: number, path: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        res.setEncoding("utf8");
        const frames: string[] = [];
        let buffer = "";
        const waiters: Array<(frame: string) => void> = [];

        res.on("data", (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            frames.push(frame);
            const waiter = waiters.shift();
            if (waiter) waiter(frame);
          }
        });

        const client: SseClient = {
          close() {
            req.destroy();
            res.destroy();
          },
          frames,
          res,
          waitForJoined(timeoutMs = 2000) {
            return new Promise((resolveFrame, rejectFrame) => {
              // Walk existing frames first.
              for (const f of frames) {
                if (f.startsWith("event: joined")) {
                  const line = f
                    .split("\n")
                    .find((l) => l.startsWith("data: "));
                  const data = line
                    ? JSON.parse(line.slice("data: ".length))
                    : null;
                  resolveFrame({ raw: f, data });
                  return;
                }
              }
              const timer = setTimeout(() => {
                rejectFrame(
                  new Error(
                    `timed out waiting for joined frame after ${timeoutMs}ms`,
                  ),
                );
              }, timeoutMs);
              const handler = (frame: string): void => {
                if (!frame.startsWith("event: joined")) {
                  waiters.push(handler);
                  return;
                }
                clearTimeout(timer);
                const line = frame
                  .split("\n")
                  .find((l) => l.startsWith("data: "));
                const data = line
                  ? JSON.parse(line.slice("data: ".length))
                  : null;
                resolveFrame({ raw: frame, data });
              };
              waiters.push(handler);
            });
          },
        };
        resolve(client);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function makePlayerDeployedEvent(
  roundId: string,
  wallet: string,
): ParsedGameEvent {
  return {
    eventName: "PlayerDeployed",
    roundId,
    walletAddress: wallet,
    pointsDeployed: "500",
  };
}

describe.skipIf(SKIP)("GET /v1/game/round/joiners (SSE)", () => {
  let createTestApp: TestAppModule["createTestApp"];
  let setupTestDb: TestDbModule["setupTestDb"];
  let teardownTestDb: TestDbModule["teardownTestDb"];
  let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;
  let port: number;

  beforeAll(async () => {
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;

    await setupTestDb();
    app = await createTestApp();
    // Bind to a random port so parallel test files don't collide, even
    // though vitest is configured serial — defence in depth.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDb();
  });

  it("responds 200 with text/event-stream content-type", async () => {
    const client = await openSseClient(port, "/v1/game/round/joiners");
    try {
      expect(client.res.statusCode).toBe(200);
      expect(String(client.res.headers["content-type"])).toMatch(
        /text\/event-stream/,
      );
      expect(String(client.res.headers["cache-control"])).toMatch(/no-cache/);
    } finally {
      client.close();
    }
  });

  it("delivers a redacted joined event for PlayerDeployed and omits wallet/points/fee", async () => {
    const client = await openSseClient(port, "/v1/game/round/joiners");
    try {
      // Small delay so the listener is registered before we emit.
      await new Promise((r) => setTimeout(r, 50));
      gameEvents.emit(
        "event",
        makePlayerDeployedEvent("42", WALLET_FULL),
        "sig-1",
      );
      const { raw, data } = await client.waitForJoined(3000);

      // Envelope: event name and data payload only — no full wallet.
      expect(raw).toContain("event: joined");
      expect(raw).not.toContain(WALLET_FULL);

      const payload = data as Record<string, unknown>;
      expect(payload.roundId).toBe("42");
      expect(payload.walletSuffix).toBe(EXPECTED_SUFFIX);
      expect(typeof payload.t).toBe("string");
      // Redaction guarantees.
      expect(Object.keys(payload).sort()).toEqual(
        ["roundId", "t", "walletSuffix"].sort(),
      );
      expect(payload.points).toBeUndefined();
      expect(payload.pointsDeployed).toBeUndefined();
      expect(payload.fee).toBeUndefined();
      expect(payload.wallet).toBeUndefined();
      expect(payload.walletAddress).toBeUndefined();
    } finally {
      client.close();
    }
  }, 10_000);

  it("filters by ?roundId=N", async () => {
    const client = await openSseClient(
      port,
      "/v1/game/round/joiners?roundId=7",
    );
    try {
      await new Promise((r) => setTimeout(r, 50));
      // Round 3 should be dropped.
      gameEvents.emit(
        "event",
        makePlayerDeployedEvent("3", WALLET_FULL),
        "sig-a",
      );
      // Round 7 should arrive.
      gameEvents.emit(
        "event",
        makePlayerDeployedEvent("7", WALLET_FULL),
        "sig-b",
      );
      const { data } = await client.waitForJoined(3000);
      const payload = data as Record<string, unknown>;
      expect(payload.roundId).toBe("7");
      // Ensure none of the earlier (round-3) frames slipped through.
      const joinedFrames = client.frames.filter((f) =>
        f.startsWith("event: joined"),
      );
      expect(joinedFrames).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("detaches its listener when the client disconnects", async () => {
    const before = gameEvents.listenerCount("event");
    const client = await openSseClient(port, "/v1/game/round/joiners");
    // Wait until the server has seen the request and attached its listener.
    await new Promise((r) => setTimeout(r, 100));
    expect(gameEvents.listenerCount("event")).toBeGreaterThan(before);
    client.close();
    // Give Fastify / Node a tick to fire the `close` event.
    await new Promise((r) => setTimeout(r, 200));
    expect(gameEvents.listenerCount("event")).toBe(before);
  });
});
