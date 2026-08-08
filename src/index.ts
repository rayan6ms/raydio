import { ConfigError, loadConfig } from "./config.js";
import { createDiscordService } from "./discord.js";
import { createLogger } from "./logger.js";
import { errorFields } from "./utils.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
type ShutdownReason = NodeJS.Signals | "startup_failure";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const discord = createDiscordService(logger);
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
      await discord.stop();
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

    logger.error({ event: "discord_startup_failed", ...errorFields(error) }, "Discord login failed");
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
