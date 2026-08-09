import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import {
  type Client,
  Events,
  GatewayIntentBits,
  type Guild,
  MessageFlags,
  type VoiceState,
} from "discord.js";

import {
  createDiscordClient,
  createDiscordMusicNotifier,
  createDiscordService,
  DISCORD_INTENTS,
  formatNowPlayingSnapshot,
  formatPlayRequestResult,
  handleQueueButtonInteraction,
  hasHumanVoiceMember,
  SAFE_ALLOWED_MENTIONS,
} from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import type { LavalinkReadiness } from "../src/music/lavalink.js";
import type { GuildPlaybackSnapshot, QueueTrack } from "../src/music/state.js";
import {
  createQueueViewController,
  formatDuration,
  formatQueueSnapshot,
} from "../src/queue-view.js";

const unavailableLavalink: LavalinkReadiness = {
  getStatus: () => "unavailable",
  isReady: () => false,
};

type TestMusicController = Parameters<typeof createDiscordService>[3];

function musicController(overrides: Partial<TestMusicController> = {}): TestMusicController {
  return {
    requestPlay: async () => ({ kind: "closed" }),
    getIdentity: () => undefined,
    getIdentities: () => [],
    getSnapshot: () => undefined,
    cleanupUnexpected: async () => false,
    updateAloneStatus: async () => false,
    setPaused: async () => ({ kind: "rejected", reason: "no-session" }),
    setVolume: async () => ({ kind: "rejected", reason: "no-session" }),
    setLoopMode: async () => ({ kind: "rejected", reason: "no-session" }),
    removeUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
    clearUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
    shuffleUpcoming: async () => ({ kind: "rejected", reason: "no-session" }),
    skip: async () => ({ kind: "rejected", reason: "no-session" }),
    stop: async () => ({ kind: "rejected", reason: "no-session" }),
    leave: async () => ({ kind: "rejected", reason: "no-session" }),
    ...overrides,
  };
}

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
    const service = createDiscordService(
      client,
      createLogger("silent"),
      unavailableLavalink,
      musicController(),
    );

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
    await assert.rejects(service.start("unused-token"), /already been stopped/);
  });

  it("tracks human presence in the active voice channel and cleans bot displacement", async () => {
    const client = createDiscordClient();
    const snapshot = playbackSnapshot();
    const updates: boolean[] = [];
    let cleanupCount = 0;
    const channel = {
      isVoiceBased: () => true,
      members: new Map([["bot", { user: { bot: true } }]]),
    };
    const botVoice: { channelId: string | null } = { channelId: "voice-1" };
    const guild = {
      id: "guild-1",
      shardId: 0,
      members: { me: { id: "bot", voice: botVoice } },
      channels: { cache: new Map([["voice-1", channel]]) },
    };
    const service = createDiscordService(
      client,
      createLogger("silent"),
      unavailableLavalink,
      musicController({
        getIdentity: () => snapshot,
        getIdentities: () => [snapshot],
        getSnapshot: () => snapshot,
        async updateAloneStatus(_guildId, _playerToken, alone) {
          updates.push(alone);
          return true;
        },
        async cleanupUnexpected() {
          cleanupCount += 1;
          return true;
        },
      }),
    );

    client.emit(
      Events.VoiceStateUpdate,
      { channelId: "voice-1" } as VoiceState,
      { id: "human", channelId: null, guild } as unknown as VoiceState,
    );
    await waitForImmediate();
    assert.deepEqual(updates, [true]);

    channel.members.set("human", { user: { bot: false } });
    client.emit(
      Events.VoiceStateUpdate,
      { channelId: null } as VoiceState,
      { id: "human", channelId: "voice-1", guild } as unknown as VoiceState,
    );
    await waitForImmediate();
    assert.deepEqual(updates, [true, false]);

    client.emit(
      Events.VoiceStateUpdate,
      { channelId: "voice-1" } as VoiceState,
      { id: "bot", channelId: null, guild } as unknown as VoiceState,
    );
    await waitForImmediate();
    assert.equal(cleanupCount, 1);

    client.guilds.cache.set("guild-1", guild as unknown as Guild);
    botVoice.channelId = null;
    client.emit(Events.ShardResume, 0, 3);
    await waitForImmediate();
    assert.equal(cleanupCount, 2);

    client.emit(Events.GuildDelete, guild as unknown as Guild);
    await waitForImmediate();
    assert.equal(cleanupCount, 3);
    client.guilds.cache.clear();

    await service.stop();
  });
});

describe("hasHumanVoiceMember", () => {
  it("ignores bots and detects at least one human listener", () => {
    assert.equal(hasHumanVoiceMember([{ user: { bot: true } }]), false);
    assert.equal(hasHumanVoiceMember([{ user: { bot: true } }, { user: { bot: false } }]), true);
  });
});

describe("createDiscordMusicNotifier", () => {
  it("bounds cleanup notifications, suppresses mentions, and rejects unavailable channels", async () => {
    const sends: unknown[] = [];
    const channel = {
      isSendable: () => true,
      send: async (options: unknown) => {
        sends.push(options);
      },
    };
    const client = {
      channels: { cache: new Map([["text-1", channel]]) },
    } as unknown as Client;
    const notifier = createDiscordMusicNotifier(client);

    await notifier.send("text-1", `@everyone ${"x".repeat(2_100)}`);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0], {
      content: `@everyone ${"x".repeat(1_989)}…`,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    await assert.rejects(notifier.send("missing", "notice"), /channel is unavailable/);
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

  it("renders bounded queue pages with stable indices, progress, and finite remaining time", () => {
    const upcoming = Array.from({ length: 12 }, (_, index) =>
      queueTrack(`${index + 1}`, {
        title: `**song ${index + 1}**\n@everyone`,
        requestedBy: { id: `user-${index}`, label: "_*requester*_" },
      }),
    );
    const snapshot = playbackSnapshot({
      current: queueTrack("current", { title: "# current" }),
      upcoming,
      paused: true,
      loopMode: "queue",
      volume: 25,
    });
    const firstPage = formatQueueSnapshot(snapshot);
    const secondPage = formatQueueSnapshot(snapshot, 1);

    assert.ok(firstPage.length <= 2_000);
    assert.ok(secondPage.length <= 2_000);
    assert.match(firstPage, /^Now playing:/);
    assert.match(firstPage, /Progress: 1:01 elapsed • 1:59 remaining/);
    assert.match(firstPage, /Upcoming • Page 1\/2:/);
    assert.equal(firstPage.includes("1. **\\*\\*song 1\\*\\* @everyone**"), true);
    assert.equal(firstPage.includes("10. **\\*\\*song 10\\*\\* @everyone**"), true);
    assert.doesNotMatch(firstPage, /^11\. /m);
    assert.match(secondPage, /Upcoming • Page 2\/2:/);
    assert.match(secondPage, /^11\. /m);
    assert.match(secondPage, /^12\. /m);
    assert.doesNotMatch(secondPage, /^1\. /m);
    assert.match(firstPage, /Finite queue time remaining: 37:59/);
    assert.match(firstPage, /Status: paused • Loop: queue • Volume: 25%/);
    assert.equal(firstPage.includes("\n@everyone"), false);
  });

  it("excludes livestreams from finite queue time and labels the omission", () => {
    const output = formatQueueSnapshot(
      playbackSnapshot({
        current: queueTrack("live", { durationMs: 0, isStream: true }),
        upcoming: [
          queueTrack("finite"),
          queueTrack("other-live", { durationMs: 0, isStream: true }),
        ],
      }),
    );

    assert.match(output, /Progress: LIVE/);
    assert.match(output, /Finite queue time remaining: 3:00 • 2 live not included/);
  });

  it("paginates with bounded session IDs and rejects stale controls", () => {
    const controller = createQueueViewController(() => "session-1");
    const snapshot = playbackSnapshot({
      upcoming: Array.from({ length: 12 }, (_, index) => queueTrack(`${index + 1}`)),
    });
    const first = controller.render(snapshot);
    const row = first.components[0]?.toJSON();
    const next = row?.components[1];

    assert.equal(first.page, 0);
    assert.equal(first.pageCount, 2);
    assert.equal(row?.components.length, 2);
    assert.ok(next !== undefined && "custom_id" in next);
    if (next === undefined || !("custom_id" in next)) {
      throw new Error("Expected a custom-ID queue button");
    }

    const nextPage = controller.resolve(snapshot.guildId, next.custom_id, snapshot);
    assert.equal(nextPage.kind, "ready");
    if (nextPage.kind !== "ready") {
      throw new Error("Expected a current queue view");
    }
    assert.equal(nextPage.view.page, 1);
    assert.match(nextPage.view.content, /^11\. /m);

    assert.deepEqual(controller.resolve(snapshot.guildId, "another:button", snapshot), {
      kind: "unrelated",
    });
    assert.deepEqual(controller.resolve("other-guild", next.custom_id, snapshot), {
      kind: "stale",
    });
    assert.deepEqual(
      controller.resolve(
        snapshot.guildId,
        next.custom_id,
        playbackSnapshot({ playerToken: Symbol("replacement"), upcoming: snapshot.upcoming }),
      ),
      { kind: "stale" },
    );
    assert.deepEqual(
      controller.resolve(snapshot.guildId, next.custom_id, playbackSnapshot({ current: null })),
      { kind: "stale" },
    );
  });

  it("bounds retained queue sessions and retires stale session state", () => {
    let sessionNumber = 0;
    const controller = createQueueViewController(() => {
      sessionNumber += 1;
      return `session-${sessionNumber}`;
    });
    const original = playbackSnapshot({
      guildId: "oldest-guild",
      upcoming: Array.from({ length: 11 }, (_, index) => queueTrack(`${index + 1}`)),
    });
    const oldNext = controller.render(original).components[0]?.toJSON().components[1];
    assert.ok(oldNext !== undefined && "custom_id" in oldNext);
    if (oldNext === undefined || !("custom_id" in oldNext)) {
      throw new Error("Expected a custom-ID queue button");
    }

    for (let index = 0; index < 1_000; index += 1) {
      controller.render(
        playbackSnapshot({ guildId: `guild-${index}`, upcoming: original.upcoming }),
      );
    }
    assert.deepEqual(controller.resolve(original.guildId, oldNext.custom_id, original), {
      kind: "stale",
    });

    const current = playbackSnapshot({
      guildId: "current-guild",
      upcoming: original.upcoming,
    });
    const currentNext = controller.render(current).components[0]?.toJSON().components[1];
    assert.ok(currentNext !== undefined && "custom_id" in currentNext);
    if (currentNext === undefined || !("custom_id" in currentNext)) {
      throw new Error("Expected a custom-ID queue button");
    }
    assert.deepEqual(controller.resolve(current.guildId, currentNext.custom_id, undefined), {
      kind: "stale",
    });
    assert.deepEqual(controller.resolve(current.guildId, currentNext.custom_id, current), {
      kind: "stale",
    });
  });

  it("clamps a page after queue shrink and omits buttons for one page", () => {
    const controller = createQueueViewController(() => "session-1");
    const token = Symbol("player");
    const original = playbackSnapshot({
      playerToken: token,
      upcoming: Array.from({ length: 12 }, (_, index) => queueTrack(`${index + 1}`)),
    });
    const next = controller.render(original).components[0]?.toJSON().components[1];
    assert.ok(next !== undefined && "custom_id" in next);
    if (next === undefined || !("custom_id" in next)) {
      throw new Error("Expected a custom-ID queue button");
    }

    const shrunk = playbackSnapshot({ playerToken: token, upcoming: [queueTrack("only")] });
    const resolution = controller.resolve(shrunk.guildId, next.custom_id, shrunk);
    assert.equal(resolution.kind, "ready");
    if (resolution.kind !== "ready") {
      throw new Error("Expected a current queue view");
    }
    assert.equal(resolution.view.page, 0);
    assert.equal(resolution.view.pageCount, 1);
    assert.deepEqual(resolution.view.components, []);
    assert.match(resolution.view.content, /^1\. /m);
    assert.deepEqual(controller.resolve(shrunk.guildId, next.custom_id, shrunk), {
      kind: "stale",
    });
  });

  it("does not allocate sessions for unpaginated queues and can retire active controls", () => {
    let allocationCount = 0;
    const controller = createQueueViewController(() => {
      allocationCount += 1;
      return `session-${allocationCount}`;
    });
    const singlePage = playbackSnapshot({ upcoming: [queueTrack("only")] });

    assert.deepEqual(controller.render(singlePage).components, []);
    assert.equal(allocationCount, 0);

    const paginated = playbackSnapshot({
      upcoming: Array.from({ length: 11 }, (_, index) => queueTrack(`${index + 1}`)),
    });
    const next = controller.render(paginated).components[0]?.toJSON().components[1];
    assert.ok(next !== undefined && "custom_id" in next);
    if (next === undefined || !("custom_id" in next)) {
      throw new Error("Expected a custom-ID queue button");
    }
    controller.retire(paginated.guildId);
    assert.deepEqual(controller.resolve(paginated.guildId, next.custom_id, paginated), {
      kind: "stale",
    });
  });

  it("updates current queue buttons and retires stale interaction messages", async () => {
    const controller = createQueueViewController(() => "session-1");
    const snapshot = playbackSnapshot({
      upcoming: Array.from({ length: 12 }, (_, index) => queueTrack(`${index + 1}`)),
    });
    const next = controller.render(snapshot).components[0]?.toJSON().components[1];
    assert.ok(next !== undefined && "custom_id" in next);
    if (next === undefined || !("custom_id" in next)) {
      throw new Error("Expected a custom-ID queue button");
    }

    const updates: unknown[] = [];
    const interaction = {
      customId: next.custom_id,
      guildId: snapshot.guildId,
      inGuild: () => true,
      update: async (options: unknown) => {
        updates.push(options);
      },
    };
    await handleQueueButtonInteraction(
      interaction as unknown as Parameters<typeof handleQueueButtonInteraction>[0],
      musicController({ getSnapshot: () => snapshot }),
      controller,
    );
    assert.equal(updates.length, 1);
    assert.match(JSON.stringify(updates[0]), /Upcoming • Page 2\/2/);

    updates.length = 0;
    await handleQueueButtonInteraction(
      interaction as unknown as Parameters<typeof handleQueueButtonInteraction>[0],
      musicController({
        getSnapshot: () => playbackSnapshot({ playerToken: Symbol("replacement") }),
      }),
      controller,
    );
    assert.deepEqual(updates, [
      {
        content: "This queue view is no longer active. Run `\\queue` again.",
        components: [],
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      },
    ]);
  });

  it("rejects queue controls outside a guild without exposing them publicly", async () => {
    const replies: unknown[] = [];
    const interaction = {
      inGuild: () => false,
      reply: async (options: unknown) => {
        replies.push(options);
      },
    };

    await handleQueueButtonInteraction(
      interaction as unknown as Parameters<typeof handleQueueButtonInteraction>[0],
      musicController(),
      createQueueViewController(),
    );
    assert.deepEqual(replies, [
      {
        content: "Queue controls are available only in a server.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      },
    ]);
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
