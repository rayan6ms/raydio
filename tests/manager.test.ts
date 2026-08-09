import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { createLogger } from "../src/logger.js";
import {
  createMusicManager,
  type MusicManager,
  type PlayRequest,
  type TimerHandle,
  type TimerScheduler,
} from "../src/music/manager.js";
import type { ResolvedTrack, ResolveResult, TrackResolver } from "../src/music/resolver.js";
import type { PlayerToken, QueueTrack } from "../src/music/state.js";

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

function request(input: string, overrides: Partial<PlayRequest> = {}): PlayRequest {
  const intendedVoiceChannelId = overrides.intendedVoiceChannelId ?? "voice-1";
  return {
    guildId: "guild-1",
    notificationChannelId: "text-1",
    intendedVoiceChannelId,
    input,
    requestedBy: { id: "user-1", label: "Requester" },
    getRequesterVoiceChannelId: () => intendedVoiceChannelId,
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
  } = {},
): MusicManager {
  return createMusicManager(
    { ...defaultConfig, ...options.config },
    {
      resolver,
      logger: createLogger("silent"),
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

    const fullResult = await manager.requestPlay(request("extra"));
    assert.deepEqual(fullResult, { kind: "queue-full" });
    assert.equal(resolver.calls[1]?.availableCapacity, 0);
  });

  it("removes, clears, and deterministically shuffles upcoming tracks without touching current", async () => {
    const resolver = new FakeResolver(async () =>
      tracks(track("a"), track("b"), track("c"), track("d")),
    );
    const samples = [0, 0.5, 0];
    const manager = managerWith(resolver, { random: () => samples.shift() ?? 0 });
    await queue(manager, "playlist");

    assert.equal((await manager.removeUpcoming("guild-1", 2))?.identifier, "c");
    assert.equal(await manager.removeUpcoming("guild-1", 0), undefined);
    assert.equal(await manager.shuffleUpcoming("guild-1"), true);
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["d", "b"],
    );
    assert.equal(await manager.clearUpcoming("guild-1"), 2);
    assert.deepEqual(manager.getSnapshot("guild-1")?.upcoming, []);
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

    assert.equal(await manager.stop("guild-1"), false);
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
    assert.equal(await leaveManager.leave("guild-1"), false);
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

  it("rechecks requester voice and same-channel ownership at commit", async () => {
    const changed = deferred<ResolveResult>();
    const resolver = new FakeResolver(async (input) =>
      input === "changed" ? changed.promise : tracks(track(input)),
    );
    const manager = managerWith(resolver);
    let actualVoice: string | null = "voice-1";
    const pending = manager.requestPlay(
      request("changed", { getRequesterVoiceChannelId: () => actualVoice }),
    );
    await waitForImmediate();
    actualVoice = "voice-2";
    changed.resolve(tracks(track("changed")));
    assert.deepEqual(await pending, { kind: "voice-changed" });
    assert.equal(manager.getSnapshot("guild-1"), undefined);

    await queue(manager, "first");
    assert.deepEqual(
      await manager.requestPlay(
        request("other-channel", {
          intendedVoiceChannelId: "voice-2",
          getRequesterVoiceChannelId: () => "voice-2",
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
    assert.equal(await manager.clearUpcoming("guild-1"), 0);
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
    await manager.leave("guild-1");
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
    const skip = manager.skip("guild-1");
    assert.equal((await finish).kind, "advanced");
    assert.deepEqual(await skip, { kind: "ignored", reason: "stale-track" });
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

    const stopping = manager.stop("guild-1");
    const ending = manager.handleTrackEnd({ ...identity, reason: "finished" });
    assert.equal(await stopping, true);
    assert.deepEqual(await ending, { kind: "ignored", reason: "stale-track" });
    assert.equal(manager.getSnapshot("guild-1")?.current, null);
    assert.deepEqual(manager.getSnapshot("guild-1")?.upcoming, []);
  });

  it("implements track and queue loops while manual skip overrides track loop", async () => {
    const resolver = new FakeResolver(async () => tracks(track("a"), track("b")));

    const trackLoop = managerWith(resolver);
    await queue(trackLoop, "track-loop");
    await trackLoop.setLoopMode("guild-1", "track");
    const trackIdentity = currentIdentity(trackLoop);
    assert.equal(
      (await trackLoop.handleTrackEnd({ ...trackIdentity, reason: "finished" })).kind,
      "replayed",
    );
    assert.equal(trackLoop.getSnapshot("guild-1")?.current?.identifier, "a");
    assert.equal((await trackLoop.skip("guild-1")).kind, "advanced");
    assert.equal(trackLoop.getSnapshot("guild-1")?.current?.identifier, "b");

    const queueLoop = managerWith(resolver);
    await queue(queueLoop, "queue-loop");
    await queueLoop.setLoopMode("guild-1", "queue");
    const queueIdentity = currentIdentity(queueLoop);
    await queueLoop.handleTrackEnd({ ...queueIdentity, reason: "finished" });
    assert.equal(queueLoop.getSnapshot("guild-1")?.current?.identifier, "b");
    assert.deepEqual(
      queueLoop.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["a"],
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
    const manager = managerWith(resolver);
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

  it("rechecks stale timer callbacks and cleans idle/alone sessions idempotently", async () => {
    const scheduler = new FakeScheduler();
    const manager = managerWith(new FakeResolver(), { scheduler });
    await queue(manager, "first");
    const firstToken = manager.getSnapshot("guild-1")?.playerToken;
    assert.ok(firstToken);

    assert.equal(await manager.stop("guild-1"), true);
    assert.equal(scheduler.timers[0]?.unrefCalled, true);
    await queue(manager, "replacement");
    assert.equal(scheduler.timers[0]?.cleared, true);
    scheduler.fire(0);
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1")?.current?.identifier, "replacement");

    assert.equal(await manager.stop("guild-1"), true);
    scheduler.fire(1);
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1"), undefined);

    await queue(manager, "alone-session");
    const token = manager.getSnapshot("guild-1")?.playerToken;
    assert.ok(token);
    assert.notEqual(token, firstToken);
    assert.equal(await manager.updateAloneStatus("guild-1", firstToken, true), false);
    assert.equal(await manager.updateAloneStatus("guild-1", token, true), true);
    assert.equal(scheduler.timers[2]?.delayMs, 120_000);
    assert.equal(await manager.updateAloneStatus("guild-1", token, false), true);
    scheduler.fire(2);
    await waitForImmediate();
    assert.ok(manager.getSnapshot("guild-1"));

    await manager.updateAloneStatus("guild-1", token, true);
    scheduler.fire(3);
    await waitForImmediate();
    assert.equal(manager.getSnapshot("guild-1"), undefined);
    assert.equal(await manager.cleanupUnexpected("guild-1"), false);
    assert.equal(await manager.leave("guild-1"), false);
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
    await assert.rejects(manager.shuffleUpcoming("guild-1"), /random must return/);
    assert.deepEqual(
      manager.getSnapshot("guild-1")?.upcoming.map((item) => item.identifier),
      ["b", "c", "d"],
    );
    assert.equal(await manager.setLoopMode("guild-1", "queue"), true);
  });
});
