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

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new ConfigError(name, "a non-empty value is required");
  }

  return value;
}

function stringWithDefault(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const value = env[name];

  if (value === undefined) {
    return defaultValue;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConfigError(name, "must not be empty");
  }

  return trimmed;
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

function logLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = stringWithDefault(env, "LOG_LEVEL", "info");

  if (!LOG_LEVELS.some((level) => level === value)) {
    throw new ConfigError("LOG_LEVEL", `must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    discordToken: requiredString(env, "DISCORD_TOKEN"),
    logLevel: logLevel(env),
    lavalink: {
      host: stringWithDefault(env, "LAVALINK_HOST", "lavalink"),
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
