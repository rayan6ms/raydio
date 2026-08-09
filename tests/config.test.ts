import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "discord-secret",
    LAVALINK_PASSWORD: "lavalink-secret",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads the documented defaults", () => {
    const config = loadConfig(validEnv());

    assert.equal(config.logLevel, "info");
    assert.deepEqual(config.lavalink, {
      host: "lavalink",
      port: 2333,
      password: "lavalink-secret",
      secure: false,
    });
    assert.deepEqual(config.playback, {
      defaultVolume: 70,
      idleDisconnectSeconds: 120,
      aloneDisconnectSeconds: 120,
      maxPlaylistTracks: 250,
      maxQueueTracks: 1_000,
      maxPendingPlayRequests: 10,
      maxTrackDurationHours: 3,
      allowLivestreams: false,
    });
  });

  it("loads explicit valid values", () => {
    const config = loadConfig(
      validEnv({
        LOG_LEVEL: "debug",
        LAVALINK_HOST: "127.0.0.1",
        LAVALINK_PORT: "2444",
        LAVALINK_SECURE: "true",
        DEFAULT_VOLUME: "0",
        IDLE_DISCONNECT_SECONDS: "1",
        ALONE_DISCONNECT_SECONDS: "2",
        MAX_PLAYLIST_TRACKS: "3",
        MAX_QUEUE_TRACKS: "4",
        MAX_PENDING_PLAY_REQUESTS: "5",
        MAX_TRACK_DURATION_HOURS: "6",
        ALLOW_LIVESTREAMS: "true",
      }),
    );

    assert.equal(config.logLevel, "debug");
    assert.equal(config.lavalink.host, "127.0.0.1");
    assert.equal(config.lavalink.port, 2444);
    assert.equal(config.lavalink.secure, true);
    assert.equal(config.playback.defaultVolume, 0);
    assert.equal(config.playback.allowLivestreams, true);
  });

  it("requires both secrets without exposing their values", () => {
    assert.throws(
      () => loadConfig(validEnv({ DISCORD_TOKEN: "" })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "DISCORD_TOKEN");
        assert.doesNotMatch(error.message, /discord-secret/);
        return true;
      },
    );

    assert.throws(
      () => loadConfig(validEnv({ LAVALINK_PASSWORD: "" })),
      (error: unknown) => error instanceof ConfigError && error.variable === "LAVALINK_PASSWORD",
    );
  });

  it("rejects malformed booleans", () => {
    for (const value of ["TRUE", "1", "yes", " false "]) {
      assert.throws(
        () => loadConfig(validEnv({ LAVALINK_SECURE: value })),
        (error: unknown) => error instanceof ConfigError && error.variable === "LAVALINK_SECURE",
      );
    }
  });

  it("rejects invalid integer values and bounds", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["LAVALINK_PORT", "0"],
      ["LAVALINK_PORT", "65536"],
      ["LAVALINK_PORT", "1.5"],
      ["DEFAULT_VOLUME", "101"],
      ["DEFAULT_VOLUME", "-1"],
      ["IDLE_DISCONNECT_SECONDS", "0"],
      ["MAX_QUEUE_TRACKS", "not-a-number"],
    ];

    for (const [name, value] of cases) {
      assert.throws(
        () => loadConfig(validEnv({ [name]: value })),
        (error: unknown) => error instanceof ConfigError && error.variable === name,
      );
    }
  });

  it("rejects unsupported log levels", () => {
    assert.throws(
      () => loadConfig(validEnv({ LOG_LEVEL: "verbose" })),
      (error: unknown) => error instanceof ConfigError && error.variable === "LOG_LEVEL",
    );
  });

  it("rejects malformed Lavalink hosts and multiline secrets before client construction", () => {
    for (const value of ["https://lavalink.example", "lavalink:2333", "host/path", "[invalid]"]) {
      assert.throws(
        () => loadConfig(validEnv({ LAVALINK_HOST: value })),
        (error: unknown) => error instanceof ConfigError && error.variable === "LAVALINK_HOST",
      );
    }

    assert.equal(loadConfig(validEnv({ LAVALINK_HOST: "::1" })).lavalink.host, "::1");
    assert.equal(loadConfig(validEnv({ LAVALINK_HOST: "[::1]" })).lavalink.host, "[::1]");
    assert.throws(
      () => loadConfig(validEnv({ LAVALINK_PASSWORD: "line-one\nline-two" })),
      (error: unknown) => error instanceof ConfigError && error.variable === "LAVALINK_PASSWORD",
    );
  });
});
