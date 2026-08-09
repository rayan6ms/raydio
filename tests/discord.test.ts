import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayIntentBits } from "discord.js";

import {
  createDiscordClient,
  createDiscordService,
  DISCORD_INTENTS,
  formatPlayRequestResult,
  SAFE_ALLOWED_MENTIONS,
} from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import type { LavalinkReadiness } from "../src/music/lavalink.js";

const unavailableLavalink: LavalinkReadiness = {
  getStatus: () => "unavailable",
  isReady: () => false,
};

describe("createDiscordService", () => {
  it("uses only the required intents and disables all automatic mentions", async () => {
    const client = createDiscordClient();
    const service = createDiscordService(client, createLogger("silent"), unavailableLavalink, {
      requestPlay: async () => ({ kind: "closed" }),
      getSnapshot: () => undefined,
      cleanupUnexpected: async () => false,
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
