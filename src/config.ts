import { isIP } from "node:net";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly discordToken: string;
  readonly logLevel: LogLevel;
  readonly lavalink: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly secure: boolean;
  };
  readonly playback: {
    readonly defaultVolume: number;
    readonly idleDisconnectSeconds: number;
    readonly aloneDisconnectSeconds: number;
    readonly maxPlaylistTracks: number;
    readonly maxQueueTracks: number;
    readonly maxPendingPlayRequests: number;
    readonly maxTrackDurationHours: number;
    readonly allowLivestreams: boolean;
  };
}

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string) {
    super(`Invalid configuration for ${variable}: ${reason}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

function hasControlOrLineSeparator(value: string): boolean {
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (value === undefined || value.length === 0) {
    throw new ConfigError(name, "a non-empty value is required");
  }

  if (hasControlOrLineSeparator(value)) {
    throw new ConfigError(name, "must be a single-line value without control characters");
  }

  if (value !== value.trim()) {
    throw new ConfigError(name, "must not have leading or trailing whitespace");
  }

  return value;
}

function stringWithDefault(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const value = env[name];

  if (value === undefined) {
    return defaultValue;
  }

  if (value.length === 0 || value.trim().length === 0) {
    throw new ConfigError(name, "must not be empty");
  }

  if (value !== value.trim()) {
    throw new ConfigError(name, "must not have leading or trailing whitespace");
  }

  return value;
}

interface IntegerOptions {
  readonly defaultValue?: number;
  readonly minimum: number;
  readonly maximum?: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, options: IntegerOptions): number {
  const raw = env[name];

  if (raw === undefined && options.defaultValue !== undefined) {
    return options.defaultValue;
  }

  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw new ConfigError(name, "an integer is required");
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.minimum) {
    throw new ConfigError(name, `must be an integer of at least ${options.minimum}`);
  }

  if (options.maximum !== undefined && value > options.maximum) {
    throw new ConfigError(name, `must be an integer of at most ${options.maximum}`);
  }

  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];

  if (raw === undefined) {
    return defaultValue;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new ConfigError(name, 'must be exactly "true" or "false"');
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function logLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = stringWithDefault(env, "LOG_LEVEL", "info");

  if (!isLogLevel(value)) {
    throw new ConfigError("LOG_LEVEL", `must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  return value;
}

function lavalinkHost(env: NodeJS.ProcessEnv): string {
  const value = stringWithDefault(env, "LAVALINK_HOST", "lavalink");
  if (hasControlOrLineSeparator(value) || /\s|[/?#@]/u.test(value)) {
    throw new ConfigError("LAVALINK_HOST", "must be a hostname or IP address without a port");
  }

  if (value.startsWith("[") || value.endsWith("]")) {
    if (!(value.startsWith("[") && value.endsWith("]") && isIP(value.slice(1, -1)) === 6)) {
      throw new ConfigError("LAVALINK_HOST", "contains invalid IPv6 brackets");
    }
    return value;
  }

  if (value.includes("[") || value.includes("]") || (value.includes(":") && isIP(value) !== 6)) {
    throw new ConfigError("LAVALINK_HOST", "must not include a scheme, path, or port");
  }

  if (isIP(value) !== 0) {
    return value;
  }

  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  const labels = hostname.split(".");
  const isValidHostname =
    hostname.length > 0 &&
    hostname.length <= 253 &&
    !/^[\d.]+$/u.test(value) &&
    labels.every(
      (label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label),
    );
  if (!isValidHostname) {
    throw new ConfigError("LAVALINK_HOST", "must be a valid hostname or IP address");
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    discordToken: requiredString(env, "DISCORD_TOKEN"),
    logLevel: logLevel(env),
    lavalink: {
      host: lavalinkHost(env),
      port: integer(env, "LAVALINK_PORT", {
        defaultValue: 2333,
        minimum: 1,
        maximum: 65_535,
      }),
      password: requiredString(env, "LAVALINK_PASSWORD"),
      secure: boolean(env, "LAVALINK_SECURE", false),
    },
    playback: {
      defaultVolume: integer(env, "DEFAULT_VOLUME", {
        defaultValue: 70,
        minimum: 0,
        maximum: 100,
      }),
      idleDisconnectSeconds: integer(env, "IDLE_DISCONNECT_SECONDS", {
        defaultValue: 120,
        minimum: 1,
      }),
      aloneDisconnectSeconds: integer(env, "ALONE_DISCONNECT_SECONDS", {
        defaultValue: 120,
        minimum: 1,
      }),
      maxPlaylistTracks: integer(env, "MAX_PLAYLIST_TRACKS", {
        defaultValue: 250,
        minimum: 1,
      }),
      maxQueueTracks: integer(env, "MAX_QUEUE_TRACKS", {
        defaultValue: 1_000,
        minimum: 1,
      }),
      maxPendingPlayRequests: integer(env, "MAX_PENDING_PLAY_REQUESTS", {
        defaultValue: 10,
        minimum: 1,
      }),
      maxTrackDurationHours: integer(env, "MAX_TRACK_DURATION_HOURS", {
        defaultValue: 3,
        minimum: 1,
      }),
      allowLivestreams: boolean(env, "ALLOW_LIVESTREAMS", false),
    },
  };
}
