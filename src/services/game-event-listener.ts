import { EventEmitter } from "node:events";
import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import {
  applyGameEvent,
  parseGameProgramLog,
  type ParsedGameEvent,
} from "./game-service.js";

export interface GameEventListenerOptions {
  rpcUrl: string;
  programId: string;
  onError?: (err: unknown) => void;
}

export interface GameEventListenerHandle {
  stop(): Promise<void>;
}

// Typed fan-out emitter. Every parsed `ParsedGameEvent` is re-emitted after
// `applyGameEvent` resolves (success OR failure — see the `finally` below).
// SSE consumers (e.g. `GET /v1/game/round/joiners`) subscribe here instead
// of opening their own RPC log subscriptions, so we keep exactly one
// `onLogs` listener open against the cluster.
//
// IMPORTANT: these are display-only events. They are NOT an authoritative
// stream — if the DB write for an event fails, the SSE subscribers still
// see it (the `finally` guarantees emission). Treat this as social-proof
// fan-out, not a durable event bus.
export interface GameEventEmitter extends EventEmitter {
  on(
    event: "event",
    listener: (e: ParsedGameEvent, signature: string) => void,
  ): this;
  off(
    event: "event",
    listener: (e: ParsedGameEvent, signature: string) => void,
  ): this;
  emit(event: "event", e: ParsedGameEvent, signature: string): boolean;
}

export const gameEvents = new EventEmitter() as GameEventEmitter;
// Bump the default 10-listener ceiling so many concurrent SSE connections
// don't trip Node's MaxListenersExceededWarning. 100 matches the rate-limit
// ceiling we expose on the joiners route (120 connections / min / client).
gameEvents.setMaxListeners(100);

export function startGameEventListener(
  options: GameEventListenerOptions,
): GameEventListenerHandle {
  const connection = new Connection(options.rpcUrl, "confirmed");
  const programId = new PublicKey(options.programId);

  const listenerId = connection.onLogs(
    programId,
    (logs: Logs) => {
      void (async () => {
        for (const message of logs.logs) {
          const event = parseGameProgramLog(message);
          if (!event) continue;
          try {
            await applyGameEvent(event, logs.signature);
          } finally {
            // Emit even if `applyGameEvent` threw — SSE subscribers are
            // display-only and shouldn't be starved by a DB hiccup.
            gameEvents.emit("event", event, logs.signature);
          }
        }
      })().catch((err) => {
        options.onError?.(err);
      });
    },
    "confirmed",
  );

  return {
    async stop(): Promise<void> {
      await connection.removeOnLogsListener(listenerId);
    },
  };
}
