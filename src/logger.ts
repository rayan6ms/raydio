import pino, { type DestinationStream, type Logger } from "pino";

import type { LogLevel } from "./config.js";

const SECRET_PATHS = [
  "discordToken",
  "token",
  "DISCORD_TOKEN",
  "lavalinkPassword",
  "password",
  "auth",
  "LAVALINK_PASSWORD",
  "req.headers.authorization",
] as const;

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: {
        service: "raydio",
      },
      redact: {
        paths: [...SECRET_PATHS],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
