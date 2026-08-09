import { ConfigError, loadConfig } from "./config.js";
import {
  createDiscordClient,
  createDiscordMusicNotifier,
  createDiscordService,
} from "./discord.js";
import { stopServicesInOrder } from "./lifecycle.js";
import { createLogger } from "./logger.js";
import { createLavalinkService } from "./music/lavalink.js";
import { createMusicManager } from "./music/manager.js";
import { createShoukakuPlaybackTransport } from "./music/player.js";
import { createTrackResolver } from "./music/resolver.js";
import { errorFields } from "./utils.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
type ShutdownReason = NodeJS.Signals | "startup_failure";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = createDiscordClient();
  const lavalink = createLavalinkService(client, config.lavalink, logger);
  const resolver = createTrackResolver(lavalink, config.playback, logger);
  const music = createMusicManager(config.playback, {
    resolver,
    transport: createShoukakuPlaybackTransport(lavalink.manager),
    logger,
    notifier: createDiscordMusicNotifier(client),
  });
  const stopListeningForLavalinkInvalidation = lavalink.onSessionInvalidated(async (reason) => {
    const cleanedSessionCount = await music.handleLavalinkInvalidation(reason);
    logger.warn(
      { event: "lavalink_sessions_invalidated", reason, cleanedSessionCount },
      "Playback sessions invalidated after Lavalink state loss",
    );
  });
  const discord = createDiscordService(client, logger, lavalink, music);
  let isShuttingDown = false;

  const shutdown = async (reason: ShutdownReason): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info({ event: "shutdown_started", reason }, "Shutting down Raydio");

    const forcedExit = setTimeout(() => {
      logger.error({ event: "shutdown_timeout", reason }, "Shutdown deadline exceeded");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forcedExit.unref();

    try {
      await stopServicesInOrder([
        {
          stop: async () => {
            stopListeningForLavalinkInvalidation();
            await music.stopService();
          },
        },
        lavalink,
        discord,
      ]);
      logger.info({ event: "shutdown_complete", reason }, "Raydio stopped");
    } catch (error: unknown) {
      logger.error(
        { event: "shutdown_failed", reason, ...errorFields(error) },
        "Raydio shutdown failed",
      );
      process.exitCode = 1;
    } finally {
      clearTimeout(forcedExit);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(
    {
      event: "startup",
      nodeVersion: process.version,
      lavalinkHost: config.lavalink.host,
      lavalinkPort: config.lavalink.port,
      lavalinkSecure: config.lavalink.secure,
    },
    "Raydio control plane initialized",
  );

  try {
    await discord.start(config.discordToken);
  } catch (error: unknown) {
    if (isShuttingDown) {
      return;
    }

    logger.error(
      { event: "discord_startup_failed", ...errorFields(error) },
      "Discord login failed",
    );
    await shutdown("startup_failure");
    throw error;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("Raydio failed to start because of an unexpected error.\n");
  }

  process.exitCode = 1;
});
