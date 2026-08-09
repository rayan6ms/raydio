import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayIntentBits } from "discord.js";

import {
  createDiscordClient,
  createDiscordService,
  DISCORD_INTENTS,
  formatDuration,
  formatNowPlayingSnapshot,
  formatPlayRequestResult,
  formatQueueSnapshot,
  SAFE_ALLOWED_MENTIONS,
} from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import type { LavalinkReadiness } from "../src/music/lavalink.js";
import type { GuildPlaybackSnapshot, QueueTrack } from "../src/music/state.js";

const unavailableLavalink: LavalinkReadiness = {
  getStatus: () => "unavailable",
  isReady: () => false,
};

function queueTrack(identifier: string, overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    encoded: `encoded-${identifier}`,
    identifier,
    title: `title-${identifier}`,
    author: `author-${identifier}`,
    durationMs: 180_000,
    isStream: false,
    uri: null,
    sourceName: "youtube",
    requestedBy: { id: `user-${identifier}`, label: `requester-${identifier}` },
    ...overrides,
  };
}

function playbackSnapshot(overrides: Partial<GuildPlaybackSnapshot> = {}): GuildPlaybackSnapshot {
  return {
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    notificationChannelId: "text-1",
    playerToken: Symbol("player"),
    current: queueTrack("current"),
    upcoming: [],
    loopMode: "off",
    volume: 70,
    paused: false,
    positionMs: 61_000,
    consecutiveFailures: 0,
    alone: false,
    ...overrides,
  };
}

describe("createDiscordService", () => {
  it("uses only the required intents and disables all automatic mentions", async () => {
    const client = createDiscordClient();
    const service = createDiscordService(client, createLogger("silent"), unavailableLavalink, {
      requestPlay: async () => ({ kind: "closed" }),
      getSnapshot: () => undefined,
      cleanupUnexpected: async () => false,
      setPaused: async () => ({ kind: "rejected", reason: "no-session" }),
      setVolume: async () => ({ kind: "rejected", reason: "no-session" }),
      setLoopMode: async () => ({ kind: "rejected", reason: "no-session" }),
      removeUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
      clearUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
      shuffleUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
      skip: async () => ({ kind: "rejected", reason: "no-session" }),
      stop: async () => ({ kind: "rejected", reason: "no-session" }),
      leave: async () => ({ kind: "rejected", reason: "no-session" }),
    });

    assert.deepEqual(DISCORD_INTENTS, [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ]);
    assert.deepEqual(service.client.options.intents.toArray().toSorted(), [
      "GuildMessages",
      "GuildVoiceStates",
      "Guilds",
      "MessageContent",
    ]);
    assert.deepEqual(service.client.options.allowedMentions, SAFE_ALLOWED_MENTIONS);
    assert.equal(service.client, client);

    await service.stop();
    await service.stop();
  });
});

describe("formatPlayRequestResult", () => {
  it("renders bounded safe track and playlist metadata with truncation notes", () => {
    assert.equal(
      formatPlayRequestResult({
        kind: "queued",
        addedTrackCount: 3,
        becameCurrent: true,
        rejectedTrackCount: 1,
        truncatedTrackCount: 4,
        commitTruncatedTrackCount: 2,
        playlistName: "@everyone *mix*",
        firstTrack: {
          encoded: "encoded",
          identifier: "id",
          title: "**song** @everyone",
          author: "author",
          durationMs: 1,
          isStream: false,
          uri: null,
          sourceName: "youtube",
          requestedBy: { id: "user", label: "label" },
        },
      }),
      "Playing **\\*\\*song\\*\\* @everyone** and queued 2 more from **@everyone \\*mix\\***. 6 omitted by queue limits; 1 unsuitable.",
    );
  });

  it("maps operational failures without exposing internal errors", () => {
    assert.equal(
      formatPlayRequestResult({ kind: "join-failed" }),
      "I could not join that voice channel. Check its permissions and try again.",
    );
    assert.equal(
      formatPlayRequestResult({
        kind: "not-queued",
        resolution: { kind: "failure", reason: "request-failed" },
      }),
      "YouTube could not load that request. Try another song.",
    );
    assert.equal(
      formatPlayRequestResult({
        kind: "commit-rejected",
        reason: { kind: "missing-permissions", permissions: ["Connect", "Speak"] },
      }),
      "I need these permissions in your voice channel: Connect, Speak.",
    );
  });
});

describe("playback presentation", () => {
  it("formats finite and long durations deterministically", () => {
    assert.equal(formatDuration(0), "0:00");
    assert.equal(formatDuration(61_999), "1:01");
    assert.equal(formatDuration(3_661_000), "1:01:01");
    assert.equal(formatDuration(Number.NaN), "0:00");
    assert.equal(formatDuration(0, true), "LIVE");
  });

  it("renders a bounded queue with stable upcoming indices and escaped flattened metadata", () => {
    const upcoming = Array.from({ length: 12 }, (_, index) =>
      queueTrack(`${index + 1}`, {
        title: `**song ${index + 1}**\n@everyone`,
        requestedBy: { id: `user-${index}`, label: "_*requester*_" },
      }),
    );
    const output = formatQueueSnapshot(
      playbackSnapshot({
        current: queueTrack("current", { title: "# current" }),
        upcoming,
        paused: true,
        loopMode: "queue",
        volume: 25,
      }),
    );

    assert.ok(output.length <= 2_000);
    assert.match(output, /^Now:/);
    assert.equal(output.includes("1. **\\*\\*song 1\\*\\* @everyone**"), true);
    assert.equal(output.includes("10. **\\*\\*song 10\\*\\* @everyone**"), true);
    assert.doesNotMatch(output, /11\. /);
    assert.match(output, /…and 2 more tracks\./);
    assert.match(output, /Status: paused • Loop: queue • Volume: 25%/);
    assert.equal(output.includes("\n@everyone"), false);
  });

  it("shows now-playing progress, live status, and empty states without internal identifiers", () => {
    const finite = formatNowPlayingSnapshot(playbackSnapshot());
    assert.match(finite, /Progress: 1:01 \/ 3:00/);
    assert.doesNotMatch(finite, /encoded-current|user-current/);

    const live = formatNowPlayingSnapshot(
      playbackSnapshot({ current: queueTrack("live", { isStream: true, durationMs: 0 }) }),
    );
    assert.match(live, /Progress: LIVE/);
    assert.equal(formatNowPlayingSnapshot(undefined), "Nothing is playing.");
    assert.equal(formatQueueSnapshot(undefined), "The queue is empty.");
  });
});
