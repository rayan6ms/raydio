import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info({ event: "shutdown_started", signal }, "Shutting down Raydio");

    const forcedExit = setTimeout(() => {
      logger.error({ event: "shutdown_timeout", signal }, "Shutdown deadline exceeded");
      process.exitCode = 1;
    }, SHUTDOWN_TIMEOUT_MS);
    forcedExit.unref();

    try {
      // Discord and Lavalink resources will be closed here as they are introduced.
      logger.info({ event: "shutdown_complete", signal }, "Raydio stopped");
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
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("Raydio failed to start because of an unexpected error.\n");
  }

  process.exitCode = 1;
});
