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

export interface LavalinkReadiness {
  isReady(): boolean;
  getStatus(): LavalinkStatus;
}

export interface LavalinkService extends LavalinkReadiness {
  readonly manager: Shoukaku;
  getReadyNode(): Node | undefined;
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

  manager.on("ready", (nodeName, lavalinkResumed, libraryResumed) => {
    if (stopped) {
      return;
    }

    status = "ready";
    logger.info(
      {
        event: "lavalink_ready",
        nodeName,
        lavalinkResumed,
        libraryResumed,
      },
      "Lavalink node ready",
    );
  });

  manager.on("reconnecting", (nodeName, reconnectsLeft, reconnectIntervalSeconds) => {
    if (stopped) {
      return;
    }

    status = "reconnecting";
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

    status = "reconnecting";
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

    status = "unavailable";
    logger.error(
      {
        event: "lavalink_unavailable",
        nodeName,
        movedPlayerCount,
      },
      "Lavalink reconnect attempts exhausted",
    );
  });

  manager.on("error", (nodeName, error) => {
    if (stopped) {
      return;
    }

    const nodeRemoved = !manager.nodes.has(nodeName);
    if (nodeRemoved) {
      status = "unavailable";
    }

    logger.error(
      {
        event: nodeRemoved ? "lavalink_unavailable" : "lavalink_error",
        nodeName,
        ...errorFields(error),
      },
      nodeRemoved ? "Lavalink reconnect attempts exhausted" : "Lavalink node error",
    );
  });

  return {
    manager,
    getStatus(): LavalinkStatus {
      return status;
    },
    isReady(): boolean {
      return status === "ready";
    },
    getReadyNode(): Node | undefined {
      return status === "ready" ? manager.getIdealNode() : undefined;
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      status = "stopped";

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
      logger.info({ event: "lavalink_stopped" }, "Lavalink client stopped");
    },
  };
}
