import type { Client } from "discord.js";
import type { Logger } from "pino";
import { Connectors, type Node, type NodeOption, Shoukaku, type ShoukakuOptions } from "shoukaku";

import type { Config } from "../config.js";
import { errorFields } from "../utils.js";

export const LAVALINK_NODE_NAME = "main";

export const SHOUKAKU_OPTIONS = {
  resume: true,
  resumeTimeout: 60,
  resumeByLibrary: false,
  reconnectTries: 24,
  reconnectInterval: 5,
  moveOnDisconnect: false,
} as const satisfies ShoukakuOptions;

export type LavalinkStatus = "connecting" | "ready" | "reconnecting" | "unavailable" | "stopped";
export type LavalinkSessionInvalidationReason = "session-lost" | "unavailable";
export type LavalinkSessionInvalidationListener = (
  reason: LavalinkSessionInvalidationReason,
) => Promise<void> | void;

export interface LavalinkReadiness {
  isReady(): boolean;
  getStatus(): LavalinkStatus;
  getDiagnostics(): LavalinkDiagnostics;
}

export interface LavalinkDiagnostics {
  readonly status: LavalinkStatus;
  readonly readyCount: number;
  readonly reconnectCount: number;
  readonly closeCount: number;
  readonly errorCount: number;
  readonly unavailableCount: number;
  readonly sessionLossCount: number;
  readonly lastEvent: string | null;
  readonly lastEventAtMs: number | null;
}

export interface LavalinkService extends LavalinkReadiness {
  readonly manager: Shoukaku;
  getReadyNode(): Node | undefined;
  onSessionInvalidated(listener: LavalinkSessionInvalidationListener): () => void;
  stop(): Promise<void>;
}

function nodeAddress(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${normalizedHost}:${port}`;
}

export function createLavalinkNode(config: Config["lavalink"]): NodeOption {
  return {
    name: LAVALINK_NODE_NAME,
    url: nodeAddress(config.host, config.port),
    auth: config.password,
    secure: config.secure,
  };
}

export function createLavalinkService(
  client: Client,
  config: Config["lavalink"],
  logger: Logger,
): LavalinkService {
  const manager = new Shoukaku(new Connectors.DiscordJS(client), [createLavalinkNode(config)], {
    ...SHOUKAKU_OPTIONS,
  });
  let status: LavalinkStatus = "connecting";
  let stopped = false;
  let transitionSequence = 0;
  const diagnostics = {
    readyCount: 0,
    reconnectCount: 0,
    closeCount: 0,
    errorCount: 0,
    unavailableCount: 0,
    sessionLossCount: 0,
    lastEvent: null as string | null,
    lastEventAtMs: null as number | null,
  };
  const invalidationListeners = new Set<LavalinkSessionInvalidationListener>();

  function recordEvent(event: string): void {
    diagnostics.lastEvent = event;
    diagnostics.lastEventAtMs = Date.now();
  }

  async function notifySessionInvalidated(
    reason: LavalinkSessionInvalidationReason,
  ): Promise<void> {
    const results = await Promise.allSettled(
      [...invalidationListeners].map(async (listener) => listener(reason)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(
          {
            event: "lavalink_session_invalidation_handler_failed",
            reason,
            ...errorFields(result.reason),
          },
          "Lavalink session invalidation handling failed",
        );
      }
    }
  }

  function markUnavailable(nodeName: string, movedPlayerCount?: number): void {
    if (stopped || status === "unavailable") {
      return;
    }

    transitionSequence += 1;
    status = "unavailable";
    diagnostics.unavailableCount += 1;
    recordEvent("unavailable");
    logger.error(
      {
        event: "lavalink_unavailable",
        nodeName,
        ...(movedPlayerCount === undefined ? {} : { movedPlayerCount }),
      },
      "Lavalink reconnect attempts exhausted",
    );
    void notifySessionInvalidated("unavailable");
  }

  manager.on("ready", (nodeName, lavalinkResumed, libraryResumed) => {
    if (stopped) {
      return;
    }

    const previousStatus = status;
    const readySequence = ++transitionSequence;
    const publishReady = (): void => {
      if (stopped || transitionSequence !== readySequence) {
        return;
      }
      status = "ready";
      diagnostics.readyCount += 1;
      recordEvent("ready");
      logger.info(
        {
          event: "lavalink_ready",
          nodeName,
          lavalinkResumed,
          libraryResumed,
        },
        "Lavalink node ready",
      );
    };

    if (previousStatus === "reconnecting" && !lavalinkResumed) {
      diagnostics.sessionLossCount += 1;
      recordEvent("session-lost");
      logger.warn(
        { event: "lavalink_session_lost", nodeName },
        "Lavalink reconnected without resuming its prior session",
      );
      void notifySessionInvalidated("session-lost").then(publishReady);
      return;
    }

    publishReady();
  });

  manager.on("reconnecting", (nodeName, reconnectsLeft, reconnectIntervalSeconds) => {
    if (stopped) {
      return;
    }

    transitionSequence += 1;
    status = "reconnecting";
    diagnostics.reconnectCount += 1;
    recordEvent("reconnecting");
    logger.warn(
      {
        event: "lavalink_reconnecting",
        nodeName,
        reconnectsLeft,
        reconnectIntervalSeconds,
      },
      "Lavalink node reconnecting",
    );
  });

  manager.on("close", (nodeName, closeCode, reason) => {
    if (stopped) {
      return;
    }

    transitionSequence += 1;
    status = "reconnecting";
    diagnostics.closeCount += 1;
    recordEvent("closed");
    logger.warn(
      {
        event: "lavalink_closed",
        nodeName,
        closeCode,
        reason,
      },
      "Lavalink connection closed",
    );
  });

  manager.on("disconnect", (nodeName, movedPlayerCount) => {
    if (stopped) {
      return;
    }

    markUnavailable(nodeName, movedPlayerCount);
  });

  manager.on("error", (nodeName, error) => {
    if (stopped) {
      return;
    }

    diagnostics.errorCount += 1;
    recordEvent("error");
    const nodeRemoved = !manager.nodes.has(nodeName);
    if (nodeRemoved) {
      markUnavailable(nodeName);
      return;
    }

    logger.error(
      {
        event: "lavalink_error",
        nodeName,
        ...errorFields(error),
      },
      "Lavalink node error",
    );
  });

  return {
    manager,
    getStatus(): LavalinkStatus {
      return status;
    },
    getDiagnostics(): LavalinkDiagnostics {
      return { status, ...diagnostics };
    },
    isReady(): boolean {
      return status === "ready";
    },
    getReadyNode(): Node | undefined {
      return status === "ready" ? manager.getIdealNode() : undefined;
    },
    onSessionInvalidated(listener): () => void {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      transitionSequence += 1;
      status = "stopped";
      recordEvent("stopped");
      invalidationListeners.clear();

      const guildIds = new Set([...manager.connections.keys(), ...manager.players.keys()]);
      const guildIdList = [...guildIds];
      const leaveResults = await Promise.allSettled(
        guildIdList.map((guildId) => manager.leaveVoiceChannel(guildId)),
      );

      for (const [index, result] of leaveResults.entries()) {
        if (result.status === "rejected") {
          logger.warn(
            {
              event: "lavalink_player_shutdown_failed",
              guildId: guildIdList[index],
              ...errorFields(result.reason),
            },
            "Could not close Lavalink player during shutdown",
          );
        }
      }

      for (const nodeName of [...manager.nodes.keys()]) {
        try {
          manager.nodes.get(nodeName)?.ws?.removeAllListeners("close");
          manager.removeNode(nodeName, "Raydio shutdown");
        } catch (error: unknown) {
          logger.warn(
            {
              event: "lavalink_node_shutdown_failed",
              nodeName,
              ...errorFields(error),
            },
            "Could not close Lavalink node during shutdown",
          );
        }
      }

      manager.removeAllListeners();
      manager.on("error", (nodeName, error) => {
        logger.debug(
          { event: "lavalink_late_error_after_stop", nodeName, ...errorFields(error) },
          "Ignored a late Lavalink error after shutdown",
        );
      });
      logger.info({ event: "lavalink_stopped" }, "Lavalink client stopped");
    },
  };
}
