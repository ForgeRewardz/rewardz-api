import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import {
  applyGameEvent,
  parseGameProgramLog,
} from "./game-service.js";

export interface GameEventListenerOptions {
  rpcUrl: string;
  programId: string;
  onError?: (err: unknown) => void;
}

export interface GameEventListenerHandle {
  stop(): Promise<void>;
}

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
          await applyGameEvent(event, logs.signature);
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
