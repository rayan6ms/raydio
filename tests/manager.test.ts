import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { createLogger } from "../src/logger.js";
import {
  type ControlResult,
  createMusicManager,
  type MusicManager,
  type PlaybackControlRequest,
  type PlayRequest,
  type TimerHandle,
  type TimerScheduler,
} from "../src/music/manager.js";
import type {
  ResolvedTrack,
  ResolveResult,
  SearchResolveResult,
  TrackResolver,
} from "../src/music/resolver.js";
import type { PlayerToken, QueueTrack } from "../src/music/state.js";
import type {
  PlaybackJoinOptions,
  PlaybackSession,
  PlaybackTransport,
} from "../src/music/transport.js";

const defaultConfig = {
  aloneDisconnectSeconds: 120,
  defaultVolume: 70,
  idleDisconnectSeconds: 120,
  maxPendingPlayRequests: 3,
  maxQueueTracks: 10,
} as const;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}

function track(identifier: string): ResolvedTrack {
  return {
    encoded: `encoded-${identifier}`,
    identifier,
    title: `title-${identifier}`,
    author: `author-${identifier}`,
    durationMs: 180_000,
    isStream: false,
    uri: `https://youtube.com/watch?v=${identifier}`,
    sourceName: "youtube",
  };
}

function tracks(...items: ResolvedTrack[]): Extract<ResolveResult, { kind: "tracks" }> {
  return {
    kind: "tracks",
    source: "youtube-music-search",
    tracks: items,
    playlistName: items.length > 1 ? "test playlist" : null,
    rejectedTrackCount: 0,
    truncatedTrackCount: 0,
  };
}

class FakeResolver implements TrackResolver {
  readonly calls: Array<{ readonly input: string; readonly availableCapacity: number }> = [];
  readonly handler: (input: string, availableCapacity: number) => Promise<ResolveResult>;

  constructor(
    handler: (input: string, availableCapacity: number) => Promise<ResolveResult> = async (input) =>
      tracks(track(input)),
  ) {
    this.handler = handler;
  }

  async resolve(input: string, availableCapacity: number): Promise<ResolveResult> {
    this.calls.push({ input, availableCapacity });
    return this.handler(input, availableCapacity);
  }

  async search(input: string, resultLimit: number): Promise<SearchResolveResult> {
    const result = await this.handler(input, resultLimit);
    return result.kind === "tracks"
      ? {
          kind: "choices",
          source: "youtube-music-search",
          tracks: result.tracks.slice(0, resultLimit),
          rejectedTrackCount: result.rejectedTrackCount,
        }
      : result;
  }
}

interface FakeTimer extends TimerHandle {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  unrefCalled: boolean;
}

class FakeScheduler implements TimerScheduler {
  readonly timers: FakeTimer[] = [];

  setTimeout(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = {
      callback,
      delayMs,
      cleared: false,
      unrefCalled: false,
      unref() {
        timer.unrefCalled = true;
      },
    };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    (handle as FakeTimer).cleared = true;
  }

  fire(index: number): void {
    this.timers[index]?.callback();
  }
}

class FakeSession implements PlaybackSession {
  readonly played: string[] = [];
  readonly paused: boolean[] = [];
  readonly volumes: number[] = [];
  stopCount = 0;
  destroyCount = 0;
  positionMs = 0;
  playError: Error | undefined;
  pauseError: Error | undefined;
  volumeError: Error | undefined;
  destroyFailuresRemaining = 0;
  readonly failingTracks = new Set<string>();

  async play(encodedTrack: string): Promise<void> {
    this.played.push(encodedTrack);
    if (this.playError !== undefined || this.failingTracks.has(encodedTrack)) {
      throw this.playError ?? new Error(`play failed for ${encodedTrack}`);
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.pauseError !== undefined) {
      throw this.pauseError;
    }
    this.paused.push(paused);
  }

  async setVolume(volume: number): Promise<void> {
    if (this.volumeError !== undefined) {
      throw this.volumeError;
    }
    this.volumes.push(volume);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  getPositionMs(): number {
    return this.positionMs;
  }

  async destroy(): Promise<void> {
    this.destroyCount += 1;
    if (this.destroyFailuresRemaining > 0) {
      this.destroyFailuresRemaining -= 1;
      throw new Error("destroy failed");
    }
  }
}

class FakeTransport implements PlaybackTransport {
  readonly joins: PlaybackJoinOptions[] = [];
  readonly sessions: FakeSession[] = [];
  joinError: Error | undefined;
  sessionPlayError: Error | undefined;

  async join(options: PlaybackJoinOptions): Promise<PlaybackSession> {
    this.joins.push(options);
    if (this.joinError !== undefined) {
      throw this.joinError;
    }
    const session = new FakeSession();
    session.playError = this.sessionPlayError;
    this.sessions.push(session);
    return session;
  }
}

function request(input: string, overrides: Partial<PlayRequest> = {}): PlayRequest {
  const intendedVoiceChannelId = overrides.intendedVoiceChannelId ?? "voice-1";
  return {
    guildId: "guild-1",
    notificationChannelId: "text-1",
    intendedVoiceChannelId,
    shardId: 0,
    input,
    requestedBy: { id: "user-1", label: "Requester" },
    validateCommit: () => ({ kind: "ready", voiceChannelId: intendedVoiceChannelId }),
    ...overrides,
  };
}

function managerWith(
  resolver: TrackResolver,
  options: {
    readonly config?: Partial<Record<keyof typeof defaultConfig, number>>;
    readonly scheduler?: TimerScheduler;
    readonly random?: () => number;
    readonly createPlayerToken?: () => PlayerToken;
    readonly transport?: PlaybackTransport;
    readonly notifier?: { send(channelId: string, content: string): Promise<void> };
  } = {},
): MusicManager {
  return createMusicManager(
    { ...defaultConfig, ...options.config },
    {
      resolver,
      transport: options.transport ?? new FakeTransport(),
      logger: createLogger("silent"),
      ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.createPlayerToken === undefined
        ? {}
        : { createPlayerToken: options.createPlayerToken }),
    },
  );
}

async function queue(manager: MusicManager, input: string, overrides: Partial<PlayRequest> = {}) {
  const result = await manager.requestPlay(request(input, overrides));
  assert.equal(result.kind, "queued");
  return result;
}

function currentIdentity(manager: MusicManager, guildId = "guild-1") {
  const snapshot = manager.getSnapshot(guildId);
  assert.ok(snapshot?.current);
  return {
    guildId,
    playerToken: snapshot.playerToken,
    encodedTrack: snapshot.current.encoded,
  };
}

function control(
  manager: MusicManager,
  overrides: Partial<PlaybackControlRequest> = {},
): PlaybackControlRequest {
  const guildId = overrides.guildId ?? "guild-1";
  const identity = manager.getIdentity(guildId);
  const intendedVoiceChannelId = overrides.intendedVoiceChannelId ?? "voice-1";
  return {
    guildId,
    intendedVoiceChannelId,
    playerToken: identity?.playerToken ?? null,
    validateCommit: () => true,
    ...overrides,
  };
}

function controlValue<Value>(result: ControlResult<Value>): Value {
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    throw new Error("Expected an accepted control result");
  }
  return result.value;
}

describe("createMusicManager", () => {
  it("owns bounded queue state and exposes detached snapshots", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b"), track("c")));
    const manager = managerWith(resolver, { config: { maxQueueTracks: 3 } });

    assert.deepEqual(await manager.requestPlay(request("playlist")), {
      kind: "queued",
      addedTrackCount: 3,
      becameCurrent: true,
      rejectedTrackCount: 0,
      truncatedTrackCount: 0,
      commitTruncatedTrackCount: 0,
      playlistName: "test playlist",
      firstTrack: {
        ...track("a"),
        requestedBy: { id: "user-1", label: "Requester" },
      },
    });
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["b", "c"],
    );

    const snapshot = manager.getSnapshot("guild-1");
    assert.ok(snapshot?.current);
    (snapshot.upcoming as QueueTrack[]).splice(0);
    (snapshot.current.requestedBy as { label: string }).label = "mutated";
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["b", "c"],
    );
    assert.equal(manager.getSnapshot("guild-1")?.current?.requestedBy.label, "Requester");
    assert.deepEqual(manager.getIdentity("guild-1"), {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      playerToken: snapshot.playerToken,
    });

    const fullResult = await manager.requestPlay(request("extra"));
    assert.deepEqual(fullResult, { kind: "queue-full" });
    assert.equal(resolver.calls[1]?.availableCapacity, 0);
  });

  it("joins once with the captured shard/channel and starts only the first committed track", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });

    assert.equal((await manager.requestPlay(request("first", { shardId: 3 }))).kind, "queued");
    assert.equal((await manager.requestPlay(request("second", { shardId: 3 }))).kind, "queued");
    assert.equal(transport.joins.length, 1);
    const join = transport.joins[0];
    assert.ok(join);
    assert.deepEqual(
      {
        guildId: join.guildId,
        voiceChannelId: join.voiceChannelId,
        shardId: join.shardId,
        initialVolume: join.initialVolume,
      },
      {
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        shardId: 3,
        initialVolume: 70,
      },
    );
    assert.deepEqual(transport.sessions[0]?.played, ["encoded-first"]);
    assert.equal(manager.getSnapshot("guild-1")?.upcoming[0]?.identifier, "second");
  });

  it("commits pause and volume only after transport succeeds and exposes player position", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });
    await queue(manager, "current");
    const session = transport.sessions[0];
    assert.ok(session);
    session.positionMs = 42_500;
    assert.equal(manager.getSnapshot("guild-1")?.positionMs, 42_500);

    assert.deepEqual(await manager.setPaused(control(manager), true), {
      kind: "ok",
      value: "updated",
    });
    assert.equal(manager.getSnapshot("guild-1")?.paused, true);
    assert.deepEqual(session.paused, [true]);
    assert.deepEqual(await manager.setPaused(control(manager), true), {
      kind: "ok",
      value: "unchanged",
    });
    assert.deepEqual(session.paused, [true]);
    assert.deepEqual(await manager.setPaused(control(manager), false), {
      kind: "ok",
      value: "updated",
    });

    assert.deepEqual(await manager.setVolume(control(manager), 25), {
      kind: "ok",
      value: { volume: 25, changed: true },
    });
    assert.equal(manager.getSnapshot("guild-1")?.volume, 25);
    assert.deepEqual(await manager.setVolume(control(manager), 25), {
      kind: "ok",
      value: { volume: 25, changed: false },
    });
    assert.deepEqual(session.volumes, [25]);

    session.pauseError = new Error("pause unavailable");
    assert.deepEqual(await manager.setPaused(control(manager), true), {
      kind: "transport-failed",
    });
    assert.equal(manager.getSnapshot("guild-1")?.paused, false);
    session.volumeError = new Error("volume unavailable");
    assert.deepEqual(await manager.setVolume(control(manager), 80), {
      kind: "transport-failed",
    });
    assert.equal(manager.getSnapshot("guild-1")?.volume, 25);
    assert.throws(() => manager.setVolume(control(manager), 101), /volume/);
  });

  it("rechecks voice, channel, and exact session identity for every control", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });
    await queue(manager, "current");
    const active = control(manager);

    assert.deepEqual(await manager.setPaused({ ...active, validateCommit: () => false }, true), {
      kind: "rejected",
      reason: "voice-changed",
    });
    assert.deepEqual(
      await manager.setLoopMode({ ...active, intendedVoiceChannelId: "voice-2" }, "queue"),
      { kind: "rejected", reason: "wrong-channel" },
    );
    assert.deepEqual(await manager.clearUpcoming({ ...active, playerToken: Symbol("stale") }), {
      kind: "rejected",
      reason: "stale-session",
    });
    assert.deepEqual(transport.sessions[0]?.paused, []);
    assert.equal(manager.getSnapshot("guild-1")?.loopMode, "off");

    const absent = managerWith(new FakeResolver());
    assert.deepEqual(await absent.setPaused(control(absent), true), {
      kind: "rejected",
      reason: "no-session",
    });
  });

  it("tears down cleanly while paused and makes repeated stop and leave idempotent", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });
    await queue(manager, "current");
    await manager.setPaused(control(manager), true);
    assert.deepEqual(await manager.stop(control(manager)), { kind: "ok", value: "stopped" });
    assert.deepEqual(await manager.stop(control(manager)), { kind: "ok", value: "unchanged" });
    assert.equal(transport.sessions[0]?.stopCount, 1);
    assert.deepEqual(await manager.setPaused(control(manager), false), {
      kind: "ok",
      value: "no-current",
    });
    assert.deepEqual(await manager.leave(control(manager)), { kind: "ok", value: true });
    assert.equal(transport.sessions[0]?.destroyCount, 1);
    assert.deepEqual(await manager.leave(control(manager)), { kind: "ok", value: false });
  });

  it("rolls back join and initial play failures without leaving a session", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });

    transport.joinError = new Error("join secret detail");
    assert.deepEqual(await manager.requestPlay(request("join-fails")), { kind: "join-failed" });
    assert.equal(manager.getSnapshot("guild-1"), undefined);

    transport.joinError = undefined;
    transport.sessionPlayError = new Error("play secret detail");
    assert.deepEqual(await manager.requestPlay(request("play-fails")), { kind: "play-failed" });
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(transport.sessions[0]?.destroyCount, 1);

    transport.sessionPlayError = undefined;
    assert.equal((await manager.requestPlay(request("recovery"))).kind, "queued");
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "recovery");
  });

  it("maps transport callbacks through manager transitions and cleans a closed session", async () => {
    const transport = new FakeTransport();
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b"), track("c")));
    const manager = managerWith(resolver, { transport });
    await queue(manager, "playlist");
    const callbacks = transport.joins[0]?.callbacks;
    const session = transport.sessions[0];
    assert.ok(callbacks);
    assert.ok(session);

    callbacks.onStart("encoded-a");
    callbacks.onException("encoded-a", "common");
    callbacks.onEnd("encoded-a", "finished");
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "b");
    assert.deepEqual(session.played, ["encoded-a", "encoded-b"]);

    callbacks.onStuck("encoded-b", 5_000);
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "c");
    assert.equal(session.stopCount, 1);
    assert.deepEqual(session.played, ["encoded-a", "encoded-b", "encoded-c"]);

    callbacks.onClosed(4017, true);
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(session.destroyCount, 1);
  });

  it("treats a transport play rejection as one bounded failure and starts the following track", async () => {
    const transport = new FakeTransport();
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b"), track("c")));
    const manager = managerWith(resolver, { transport });
    await queue(manager, "playlist");
    const callbacks = transport.joins[0]?.callbacks;
    const session = transport.sessions[0];
    assert.ok(callbacks);
    assert.ok(session);
    session.failingTracks.add("encoded-b");

    callbacks.onEnd("encoded-a", "finished");
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "c");
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 1);
    assert.deepEqual(session.played, ["encoded-a", "encoded-b", "encoded-c"]);
  });

  it("stops intake, destroys sessions, and invalidates in-flight work during service shutdown", async () => {
    const blocked = deferred<ResolveResult>();
    const transport = new FakeTransport();
    const resolver = new FakeResolver(async (input) =>
      input === "pending" ? blocked.promise : tracks(track(input)),
    );
    const manager = managerWith(resolver, { transport });
    await queue(manager, "current");
    const pending = manager.requestPlay(request("pending"));
    await waitForImmediate();

    await manager.stopService();
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(transport.sessions[0]?.destroyCount, 1);
    blocked.resolve(tracks(track("late")));
    assert.deepEqual(await pending, { kind: "stale" });
    assert.deepEqual(await manager.requestPlay(request("after-stop")), { kind: "closed" });
    await manager.stopService();
  });

  it("removes, clears, and deterministically shuffles upcoming tracks without touching current", async () => {
    const resolver = new FakeResolver(async () =>
      tracks(track("a"), track("b"), track("c"), track("d")),
    );
    const samples = [0, 0.5, 0];
    const manager = managerWith(resolver, { random: () => samples.shift() ?? 0 });
    await queue(manager, "playlist");

    assert.equal(controlValue(await manager.removeUpcoming(control(manager), 2))?.identifier, "c");
    assert.deepEqual(await manager.removeUpcoming(control(manager), 0), {
      kind: "ok",
      value: null,
    });
    assert.deepEqual(await manager.shuffleUpcoming(control(manager)), { kind: "ok", value: true });
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["d", "b"],
    );
    assert.deepEqual(await manager.clearUpcoming(control(manager)), { kind: "ok", value: 2 });
    assert.deepEqual(manager.getSnapshot("guild-1")?.upcoming, []);
  });

  it("moves upcoming tracks and jumps exactly once without discarding the others", async () => {
    const resolver = new FakeResolver(async () =>
      tracks(track("a"), track("b"), track("c"), track("d")),
    );
    const transport = new FakeTransport();
    const manager = managerWith(resolver, { transport });
    await queue(manager, "playlist");

    const moved = controlValue(await manager.moveUpcoming(control(manager), 3, 1));
    assert.equal(moved?.track.identifier, "d");
    assert.equal(moved?.changed, true);
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["d", "b", "c"],
    );
    assert.equal(controlValue(await manager.moveUpcoming(control(manager), 1, 1))?.changed, false);
    assert.equal(controlValue(await manager.moveUpcoming(control(manager), 9, 1)), null);

    const jumped = controlValue(await manager.jump(control(manager), 3));
    assert.equal(jumped?.kind, "advanced");
    assert.equal(jumped?.kind === "advanced" ? jumped.current?.identifier : null, "c");
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "c");
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["d", "b"],
    );
    assert.equal(manager.getSnapshot("guild-1")?.historyCount, 1);
    assert.deepEqual(transport.sessions[0]?.played, ["encoded-a", "encoded-c"]);
    assert.equal(controlValue(await manager.jump(control(manager), 9)), null);
  });

  it("bounds search preparation and rechecks guild voice and queue state", async () => {
    const resolver = new FakeResolver(async () =>
      tracks(track("one"), track("two"), track("three"), track("four"), track("five")),
    );
    const manager = managerWith(resolver, { config: { maxQueueTracks: 6 } });

    const searchResult = await manager.searchTracks({
      guildId: "guild-1",
      intendedVoiceChannelId: "voice-1",
      input: "choices",
      resultLimit: 5,
    });
    assert.equal(searchResult.kind, "choices");
    if (searchResult.kind === "choices") {
      assert.deepEqual(
        searchResult.tracks.map((item) => item.identifier),
        ["one", "two", "three", "four", "five"],
      );
    }

    await queue(manager, "first");
    assert.deepEqual(
      await manager.searchTracks({
        guildId: "guild-1",
        intendedVoiceChannelId: "voice-2",
        input: "wrong voice",
        resultLimit: 5,
      }),
      { kind: "wrong-channel" },
    );
    await queue(manager, "second");
    assert.deepEqual(
      await manager.searchTracks({
        guildId: "guild-1",
        intendedVoiceChannelId: "voice-1",
        input: "full",
        resultLimit: 5,
      }),
      { kind: "queue-full" },
    );
    await assert.rejects(
      manager.searchTracks({
        guildId: "guild-1",
        intendedVoiceChannelId: "voice-1",
        input: "invalid limit",
        resultLimit: 0,
      }),
      RangeError,
    );
  });

  it("keeps bounded history and returns to the prior track without losing current", async () => {
    const allTracks = Array.from({ length: 22 }, (_, index) => track(String(index + 1)));
    const resolver = new FakeResolver(async () => tracks(...allTracks));
    const transport = new FakeTransport();
    const manager = managerWith(resolver, {
      config: { maxQueueTracks: 30 },
      transport,
    });
    await queue(manager, "playlist");

    await manager.handleTrackEnd({ ...currentIdentity(manager), reason: "finished" });
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "2");
    assert.equal(manager.getSnapshot("guild-1")?.historyCount, 1);

    const previous = controlValue(await manager.previous(control(manager)));
    assert.equal(previous?.identifier, "1");
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "1");
    assert.deepEqual(
      manager
        .getSnapshot("guild-1")
        ?.upcoming.slice(0, 3)
        .map((item) => item.identifier),
      ["2", "3", "4"],
    );
    assert.equal(manager.getSnapshot("guild-1")?.historyCount, 0);
    assert.deepEqual(transport.sessions[0]?.played.slice(0, 3), [
      "encoded-1",
      "encoded-2",
      "encoded-1",
    ]);
    assert.equal(controlValue(await manager.previous(control(manager))), null);

    for (let index = 0; index < 21; index += 1) {
      await manager.handleTrackEnd({ ...currentIdentity(manager), reason: "finished" });
    }
    assert.equal(manager.getSnapshot("guild-1")?.historyCount, 20);
    await manager.stop(control(manager));
    assert.equal(manager.getSnapshot("guild-1")?.historyCount, 0);
  });

  it("orders play requests, caps pending work, and releases capacity after rejection", async () => {
    const first = deferred<ResolveResult>();
    const resolver = new FakeResolver(async (input) => {
      if (input === "first") {
        return first.promise;
      }
      if (input === "throws") {
        throw new Error("resolver rejected");
      }
      return tracks(track(input));
    });
    const manager = managerWith(resolver, { config: { maxPendingPlayRequests: 2 } });

    const firstRequest = manager.requestPlay(request("first"));
    const secondRequest = manager.requestPlay(request("second"));
    assert.deepEqual(await manager.requestPlay(request("third")), { kind: "pending-limit" });
    await waitForImmediate();
    assert.deepEqual(
      resolver.calls.map((call) => call.input),
      ["first"],
    );
    assert.equal(manager.getPendingPlayRequestCount("guild-1"), 2);

    first.resolve(tracks(track("first")));
    assert.equal((await firstRequest).kind, "queued");
    assert.equal((await secondRequest).kind, "queued");
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["second"],
    );
    assert.equal(manager.getPendingPlayRequestCount("guild-1"), 0);

    await assert.rejects(manager.requestPlay(request("throws")), /resolver rejected/);
    assert.equal(manager.getPendingPlayRequestCount("guild-1"), 0);
    assert.equal((await manager.requestPlay(request("after"))).kind, "queued");
  });

  it("lets different guilds resolve independently", async () => {
    const blocked = deferred<ResolveResult>();
    const resolver = new FakeResolver(async (input) =>
      input === "blocked" ? blocked.promise : tracks(track(input)),
    );
    const manager = managerWith(resolver);

    const guildA = manager.requestPlay(request("blocked", { guildId: "guild-a" }));
    const guildB = manager.requestPlay(request("free", { guildId: "guild-b" }));
    assert.equal((await guildB).kind, "queued");
    assert.equal(manager.getSnapshot("guild-b")?.current?.identifier, "free");

    blocked.resolve(tracks(track("blocked")));
    assert.equal((await guildA).kind, "queued");
  });

  it("uses both epoch checks and prevents stop from leaving queued remote work behind", async () => {
    const blocked = deferred<ResolveResult>();
    const resolver = new FakeResolver(async () => blocked.promise);
    const manager = managerWith(resolver);

    const resolving = manager.requestPlay(request("resolving"));
    const waiting = manager.requestPlay(request("waiting"));
    await waitForImmediate();
    assert.deepEqual(
      resolver.calls.map((call) => call.input),
      ["resolving"],
    );

    assert.deepEqual(await manager.stop(control(manager)), { kind: "ok", value: "unchanged" });
    blocked.resolve(tracks(track("resolved-too-late")));
    assert.deepEqual(await resolving, { kind: "stale" });
    assert.deepEqual(await waiting, { kind: "stale" });
    assert.equal(resolver.calls.length, 1);
    assert.equal(manager.getSnapshot("guild-1"), undefined);
  });

  it("invalidates resolving work on leave and unexpected cleanup", async () => {
    const leaveResolution = deferred<ResolveResult>();
    const leaveManager = managerWith(new FakeResolver(async () => leaveResolution.promise));
    const leaving = leaveManager.requestPlay(request("leaving"));
    await waitForImmediate();
    assert.deepEqual(await leaveManager.leave(control(leaveManager)), { kind: "ok", value: false });
    leaveResolution.resolve(tracks(track("too-late")));
    assert.deepEqual(await leaving, { kind: "stale" });

    const cleanupResolution = deferred<ResolveResult>();
    const cleanupResolver = new FakeResolver(async (input) =>
      input === "pending" ? cleanupResolution.promise : tracks(track(input)),
    );
    const cleanupManager = managerWith(cleanupResolver);
    await queue(cleanupManager, "current");
    const cleaning = cleanupManager.requestPlay(request("pending"));
    await waitForImmediate();
    assert.equal(await cleanupManager.cleanupUnexpected("guild-1"), true);
    cleanupResolution.resolve(tracks(track("too-late")));
    assert.deepEqual(await cleaning, { kind: "stale" });
    assert.equal(cleanupManager.getSnapshot("guild-1"), undefined);
  });

  it("retries failed transport cleanup once without restoring deleted playback state", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), { transport });
    await queue(manager, "current");
    const session = transport.sessions[0];
    assert.ok(session);
    session.destroyFailuresRemaining = 1;

    assert.equal(await manager.cleanupUnexpected("guild-1"), true);
    assert.equal(session.destroyCount, 2);
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(await manager.cleanupUnexpected("guild-1"), false);
  });

  it("invalidates all Lavalink-backed state idempotently and explains recoverable outages", async () => {
    const transport = new FakeTransport();
    const notifications: Array<{ readonly channelId: string; readonly content: string }> = [];
    const manager = managerWith(new FakeResolver(), {
      transport,
      notifier: {
        async send(channelId, content) {
          notifications.push({ channelId, content });
        },
      },
    });
    await queue(manager, "one");
    await queue(manager, "two", {
      guildId: "guild-2",
      notificationChannelId: "text-2",
      intendedVoiceChannelId: "voice-2",
    });

    assert.equal(manager.getIdentities().length, 2);
    assert.equal(await manager.handleLavalinkInvalidation("unavailable"), 2);
    assert.equal(await manager.handleLavalinkInvalidation("unavailable"), 0);
    assert.equal(manager.getIdentities().length, 0);
    assert.deepEqual(
      transport.sessions.map((session) => session.destroyCount),
      [1, 1],
    );
    assert.deepEqual(notifications, [
      {
        channelId: "text-1",
        content:
          "Playback ended because Lavalink became unavailable. Use `/play` after it recovers.",
      },
      {
        channelId: "text-2",
        content:
          "Playback ended because Lavalink became unavailable. Use `/play` after it recovers.",
      },
    ]);

    await queue(manager, "after-restart");
    assert.equal(await manager.handleLavalinkInvalidation("session-lost"), 1);
    assert.deepEqual(notifications.at(-1), {
      channelId: "text-1",
      content: "Playback ended because Lavalink restarted. Use `/play` to start again.",
    });
  });

  it("invalidates in-flight resolution when Lavalink becomes unavailable", async () => {
    const blocked = deferred<ResolveResult>();
    const manager = managerWith(new FakeResolver(async () => blocked.promise));
    const pending = manager.requestPlay(request("pending"));

    assert.equal(manager.getPendingPlayRequestCount("guild-1"), 1);
    assert.equal(await manager.handleLavalinkInvalidation("unavailable"), 0);
    blocked.resolve(tracks(track("too-late")));

    assert.deepEqual(await pending, { kind: "stale" });
    assert.equal(manager.getSnapshot("guild-1"), undefined);
  });

  it("finishes outage cleanup when its user notification fails", async () => {
    const transport = new FakeTransport();
    const manager = managerWith(new FakeResolver(), {
      transport,
      notifier: {
        async send() {
          throw new Error("notification unavailable");
        },
      },
    });
    await queue(manager, "current");

    assert.equal(await manager.handleLavalinkInvalidation("unavailable"), 1);
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(transport.sessions[0]?.destroyCount, 1);
  });

  it("rechecks requester voice and same-channel ownership at commit", async () => {
    const changed = deferred<ResolveResult>();
    const resolver = new FakeResolver(async (input) =>
      input === "changed" ? changed.promise : tracks(track(input)),
    );
    const manager = managerWith(resolver);
    let actualVoice: string | null = "voice-1";
    const pending = manager.requestPlay(
      request("changed", {
        validateCommit: () =>
          actualVoice === "voice-1"
            ? { kind: "ready", voiceChannelId: actualVoice }
            : { kind: "voice-changed" },
      }),
    );
    await waitForImmediate();
    actualVoice = "voice-2";
    changed.resolve(tracks(track("changed")));
    assert.deepEqual(await pending, {
      kind: "commit-rejected",
      reason: { kind: "voice-changed" },
    });
    assert.equal(manager.getSnapshot("guild-1"), undefined);

    await queue(manager, "first");
    assert.deepEqual(
      await manager.requestPlay(
        request("other-channel", {
          intendedVoiceChannelId: "voice-2",
          validateCommit: () => ({ kind: "ready", voiceChannelId: "voice-2" }),
        }),
      ),
      { kind: "wrong-channel" },
    );
    assert.equal(
      resolver.calls.some((call) => call.input === "other-channel"),
      false,
    );
  });

  it("does not invalidate pending play requests when clearing upcoming tracks", async () => {
    const blocked = deferred<ResolveResult>();
    const resolver = new FakeResolver(async (input) =>
      input === "pending" ? blocked.promise : tracks(track(input)),
    );
    const manager = managerWith(resolver);
    await queue(manager, "current");

    const pending = manager.requestPlay(request("pending"));
    await waitForImmediate();
    assert.deepEqual(await manager.clearUpcoming(control(manager)), { kind: "ok", value: 0 });
    blocked.resolve(tracks(track("pending")));
    assert.equal((await pending).kind, "queued");
    assert.equal(manager.getSnapshot("guild-1")?.upcoming[0]?.identifier, "pending");
  });

  it("rejects stale session and stale track events", async () => {
    let tokenNumber = 0;
    const manager = managerWith(new FakeResolver(), {
      createPlayerToken: () => {
        tokenNumber += 1;
        return Symbol(`player-${tokenNumber}`);
      },
    });
    await queue(manager, "old");
    const oldIdentity = currentIdentity(manager);
    await manager.leave(control(manager));
    await queue(manager, "new");

    assert.deepEqual(await manager.handleTrackEnd({ ...oldIdentity, reason: "finished" }), {
      kind: "ignored",
      reason: "stale-session",
    });
    const active = currentIdentity(manager);
    assert.deepEqual(
      await manager.handleTrackEnd({ ...active, encodedTrack: "different", reason: "finished" }),
      { kind: "ignored", reason: "stale-track" },
    );
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "new");
  });

  it("uses one transition path so a finish and skip race advances only once", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("a"), track("c")));
    const manager = managerWith(resolver);
    await queue(manager, "playlist");
    const identity = currentIdentity(manager);

    const finish = manager.handleTrackEnd({ ...identity, reason: "finished" });
    const skip = manager.skip(control(manager));
    assert.equal((await finish).kind, "advanced");
    assert.deepEqual(await skip, {
      kind: "ok",
      value: { kind: "ignored", reason: "stale-track" },
    });
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["c"],
    );
  });

  it("cannot advance after stop when a natural end event races it", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b"), track("c")));
    const manager = managerWith(resolver);
    await queue(manager, "playlist");
    const identity = currentIdentity(manager);

    const stopping = manager.stop(control(manager));
    const ending = manager.handleTrackEnd({ ...identity, reason: "finished" });
    assert.deepEqual(await stopping, { kind: "ok", value: "stopped" });
    assert.deepEqual(await ending, { kind: "ignored", reason: "stale-track" });
    assert.equal(manager.getSnapshot("guild-1")?.current, null);
    assert.deepEqual(manager.getSnapshot("guild-1")?.upcoming, []);
  });

  it("implements track and queue loops while manual skip overrides track loop", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b")));

    const trackLoop = managerWith(resolver);
    await queue(trackLoop, "track-loop");
    await trackLoop.setLoopMode(control(trackLoop), "track");
    const trackIdentity = currentIdentity(trackLoop);
    assert.equal(
      (await trackLoop.handleTrackEnd({ ...trackIdentity, reason: "finished" })).kind,
      "replayed",
    );
    assert.equal(trackLoop.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.equal(controlValue(await trackLoop.skip(control(trackLoop))).kind, "advanced");
    assert.equal(trackLoop.getSnapshot("guild-1")?.current?.identifier, "b");

    const queueLoop = managerWith(resolver);
    await queue(queueLoop, "queue-loop");
    await queueLoop.setLoopMode(control(queueLoop), "queue");
    const queueIdentity = currentIdentity(queueLoop);
    await queueLoop.handleTrackEnd({ ...queueIdentity, reason: "finished" });
    assert.equal(queueLoop.getSnapshot("guild-1")?.current?.identifier, "b");
    assert.deepEqual(
      queueLoop.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["a"],
    );
    assert.equal(controlValue(await queueLoop.previous(control(queueLoop)))?.identifier, "a");
    assert.equal(queueLoop.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.deepEqual(
      queueLoop.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["b"],
    );
  });

  it("treats non-advancing end reasons and exception events as observational", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b")));
    const manager = managerWith(resolver);
    await queue(manager, "playlist");
    const identity = currentIdentity(manager);

    for (const reason of ["stopped", "replaced", "cleanup"] as const) {
      assert.deepEqual(await manager.handleTrackEnd({ ...identity, reason }), {
        kind: "ignored",
        reason: "end-reason",
      });
    }
    assert.deepEqual(await manager.handleTrackException(identity), {
      kind: "ignored",
      reason: "end-reason",
    });
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "a");
  });

  it("advances failures once and stops after three consecutive failed or stuck tracks", async () => {
    const resolver = new FakeResolver(async () =>
      tracks(track("a"), track("b"), track("c"), track("d")),
    );
    const notifications: string[] = [];
    const manager = managerWith(resolver, {
      notifier: {
        async send(channelId, content) {
          notifications.push(`${channelId}:${content}`);
        },
      },
    });
    await queue(manager, "playlist");

    const first = currentIdentity(manager);
    assert.equal(
      (await manager.handleTrackEnd({ ...first, reason: "loadFailed" })).kind,
      "advanced",
    );
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 1);

    const second = currentIdentity(manager);
    assert.equal((await manager.handleTrackStuck(second)).kind, "advanced");
    assert.deepEqual(await manager.handleTrackEnd({ ...second, reason: "stopped" }), {
      kind: "ignored",
      reason: "end-reason",
    });
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "c");

    const third = currentIdentity(manager);
    assert.deepEqual(await manager.handleTrackEnd({ ...third, reason: "loadFailed" }), {
      kind: "failure-guard",
    });
    assert.equal(manager.getSnapshot("guild-1")?.current, null);
    assert.deepEqual(manager.getSnapshot("guild-1")?.upcoming, []);
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 3);
    await Promise.resolve();
    assert.deepEqual(notifications, [
      "text-1:Playback stopped after three consecutive track failures. The source may be unhealthy.",
    ]);

    await queue(manager, "recovery");
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 0);
  });

  it("resets the failure counter after a normal finish", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b"), track("c")));
    const manager = managerWith(resolver);
    await queue(manager, "playlist");

    await manager.handleTrackEnd({ ...currentIdentity(manager), reason: "loadFailed" });
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 1);
    await manager.handleTrackEnd({ ...currentIdentity(manager), reason: "finished" });
    assert.equal(manager.getSnapshot("guild-1")?.consecutiveFailures, 0);
  });

  it("advances finite tracks if Lavalink misses the natural end event", async () => {
    const scheduler = new FakeScheduler();
    const transport = new FakeTransport();
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b")));
    const manager = managerWith(resolver, { scheduler, transport });
    await queue(manager, "playlist");

    const watchdog = scheduler.timers.find((timer) => timer.delayMs === 195_000);
    assert.ok(watchdog);
    assert.equal(watchdog.unrefCalled, true);
    watchdog.callback();
    await waitForImmediate();
    await waitForImmediate();

    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "b");
    assert.deepEqual(transport.sessions[0]?.played, ["encoded-a", "encoded-b"]);
    assert.notEqual(
      scheduler.timers.findLast((timer) => !timer.cleared),
      watchdog,
    );
  });

  it("rechecks stale timer callbacks and cleans idle/alone sessions idempotently", async () => {
    const scheduler = new FakeScheduler();
    const manager = managerWith(new FakeResolver(), { scheduler });
    await queue(manager, "first");
    const firstToken = manager.getSnapshot("guild-1")?.playerToken;
    assert.ok(firstToken);

    assert.deepEqual(await manager.stop(control(manager)), { kind: "ok", value: "stopped" });
    const firstIdle = scheduler.timers.find((timer) => timer.delayMs === 120_000 && !timer.cleared);
    assert.ok(firstIdle);
    assert.equal(firstIdle.unrefCalled, true);
    await queue(manager, "replacement");
    assert.equal(firstIdle.cleared, true);
    firstIdle.callback();
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "replacement");

    assert.deepEqual(await manager.stop(control(manager)), { kind: "ok", value: "stopped" });
    const secondIdle = scheduler.timers.find(
      (timer) => timer.delayMs === 120_000 && !timer.cleared,
    );
    assert.ok(secondIdle);
    secondIdle.callback();
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1"), undefined);

    await queue(manager, "alone-session");
    const token = manager.getSnapshot("guild-1")?.playerToken;
    assert.ok(token);
    assert.notEqual(token, firstToken);
    assert.equal(await manager.updateAloneStatus("guild-1", firstToken, true), false);
    assert.equal(await manager.updateAloneStatus("guild-1", token, true), true);
    const firstAlone = scheduler.timers.findLast(
      (timer) => timer.delayMs === 120_000 && !timer.cleared,
    );
    assert.ok(firstAlone);
    assert.equal(await manager.updateAloneStatus("guild-1", token, false), true);
    firstAlone.callback();
    await waitForImmediate();
    assert.ok(manager.getSnapshot("guild-1"));

    await manager.updateAloneStatus("guild-1", token, true);
    const secondAlone = scheduler.timers.findLast(
      (timer) => timer.delayMs === 120_000 && !timer.cleared,
    );
    assert.ok(secondAlone);
    secondAlone.callback();
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(await manager.cleanupUnexpected("guild-1"), false);
    assert.deepEqual(await manager.leave(control(manager)), { kind: "ok", value: false });
  });

  it("validates manager bounds and rejects invalid shuffle randomness without poisoning state work", async () => {
    assert.throws(
      () => managerWith(new FakeResolver(), { config: { maxPendingPlayRequests: 0 } }),
      /maxPendingPlayRequests/,
    );
    const manager = managerWith(
      new FakeResolver(async () => tracks(track("a"), track("b"), track("c"), track("d"))),
      {
        random: (() => {
          const samples = [0, 1];
          return () => samples.shift() ?? 0;
        })(),
      },
    );
    await queue(manager, "playlist");
    await assert.rejects(manager.shuffleUpcoming(control(manager)), /random must return/);
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["b", "c", "d"],
    );
    assert.deepEqual(await manager.setLoopMode(control(manager), "queue"), {
      kind: "ok",
      value: "queue",
    });
  });
});
