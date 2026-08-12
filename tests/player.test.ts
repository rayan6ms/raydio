import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { Player, Shoukaku } from "shoukaku";

import { createShoukakuPlaybackTransport } from "../src/music/player.js";
import type { PlaybackSessionCallbacks } from "../src/music/transport.js";

interface FakePlayer extends EventEmitter {
  track: string | null;
  playCalls: unknown[];
  volumes: number[];
  stopCount: number;
  pauseCalls: boolean[];
  paused: boolean;
  position: number;
  volumeError: Error | undefined;
  playTrack(options: unknown): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setGlobalVolume(volume: number): Promise<void>;
  stopTrack(): Promise<void>;
}

function fakePlayer(): FakePlayer {
  const player = new EventEmitter() as FakePlayer;
  player.track = null;
  player.playCalls = [];
  player.volumes = [];
  player.stopCount = 0;
  player.pauseCalls = [];
  player.paused = false;
  player.position = 0;
  player.volumeError = undefined;
  player.playTrack = async (options) => {
    player.playCalls.push(options);
  };
  player.setPaused = async (paused) => {
    player.pauseCalls.push(paused);
    player.paused = paused;
  };
  player.setGlobalVolume = async (volume) => {
    if (player.volumeError !== undefined) {
      throw player.volumeError;
    }
    player.volumes.push(volume);
  };
  player.stopTrack = async () => {
    player.stopCount += 1;
  };
  return player;
}

function callbacks(events: string[]): PlaybackSessionCallbacks {
  return {
    onStart: (encoded) => events.push(`start:${encoded}`),
    onEnd: (encoded, reason) => events.push(`end:${encoded}:${reason}`),
    onException: (encoded, severity) => events.push(`exception:${encoded}:${severity}`),
    onStuck: (encoded, threshold) => events.push(`stuck:${encoded}:${threshold}`),
    onClosed: (code, byRemote) => events.push(`closed:${code}:${byRemote}`),
  };
}

describe("createShoukakuPlaybackTransport", () => {
  it("joins self-deafened, sets volume, maps player operations/events, and destroys once", async () => {
    const player = fakePlayer();
    const joins: unknown[] = [];
    const leaves: string[] = [];
    const client = {
      async joinVoiceChannel(options: unknown) {
        joins.push(options);
        return player as unknown as Player;
      },
      async leaveVoiceChannel(guildId: string) {
        leaves.push(guildId);
      },
    } as unknown as Shoukaku;
    const events: string[] = [];
    let nowMs = 1_000;
    const session = await createShoukakuPlaybackTransport(client, () => nowMs).join({
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      shardId: 2,
      initialVolume: 70,
      callbacks: callbacks(events),
    });

    assert.deepEqual(joins, [
      {
        guildId: "guild-1",
        channelId: "voice-1",
        shardId: 2,
        deaf: true,
        mute: false,
      },
    ]);
    assert.deepEqual(player.volumes, [70]);
    await session.play("encoded-a");
    await session.setPaused(true);
    await session.setVolume(55);
    await session.stop();
    assert.deepEqual(player.playCalls, [{ track: { encoded: "encoded-a" } }]);
    assert.equal(player.stopCount, 1);
    assert.deepEqual(player.pauseCalls, [true]);
    assert.deepEqual(player.volumes, [70, 55]);
    player.position = 12_345;
    player.track = "encoded-a";
    player.emit("update", { state: { position: 12_345, connected: true, ping: 1 } });
    assert.equal(session.getPositionMs(), 12_345);
    await session.setPaused(false);
    nowMs += 500;
    assert.equal(session.getPositionMs(), 12_845);
    await session.setPaused(true);
    nowMs += 500;
    assert.equal(session.getPositionMs(), 12_845);
    await session.play("encoded-b");
    assert.equal(session.getPositionMs(), 0);

    player.emit("start", { type: "TrackStartEvent", track: { encoded: "encoded-a" } });
    player.emit("end", {
      type: "TrackEndEvent",
      track: { encoded: "encoded-a" },
      reason: "finished",
    });
    player.emit("stuck", {
      type: "TrackStuckEvent",
      track: { encoded: "encoded-b" },
      thresholdMs: 5_000,
    });
    player.emit("exception", {
      type: "TrackExceptionEvent",
      track: { encoded: "encoded-b" },
      exception: { severity: "suspicious" },
    });
    player.track = "encoded-fallback";
    player.emit("exception", {
      type: "TrackExceptionEvent",
      exception: { severity: "common" },
    });
    player.emit("closed", { code: 4017, byRemote: true });
    assert.deepEqual(events, [
      "start:encoded-a",
      "end:encoded-a:finished",
      "stuck:encoded-b:5000",
      "exception:encoded-b:suspicious",
      "exception:encoded-fallback:common",
      "closed:4017:true",
    ]);

    await session.destroy();
    await session.destroy();
    assert.deepEqual(leaves, ["guild-1"]);
    player.emit("start", { type: "TrackStartEvent", track: { encoded: "ignored" } });
    assert.equal(events.includes("start:ignored"), false);
    await assert.rejects(session.play("after-destroy"), /destroyed/);
    await assert.rejects(session.setPaused(false), /destroyed/);
    await assert.rejects(session.setVolume(10), /destroyed/);
  });

  it("leaves the voice connection when initial volume setup fails", async () => {
    const player = fakePlayer();
    player.volumeError = new Error("volume failed");
    const leaves: string[] = [];
    const client = {
      async joinVoiceChannel() {
        return player as unknown as Player;
      },
      async leaveVoiceChannel(guildId: string) {
        leaves.push(guildId);
      },
    } as unknown as Shoukaku;

    await assert.rejects(
      createShoukakuPlaybackTransport(client).join({
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        shardId: 0,
        initialVolume: 70,
        callbacks: callbacks([]),
      }),
      /volume failed/,
    );
    assert.deepEqual(leaves, ["guild-1"]);
  });

  it("shares concurrent destruction and permits cleanup retry after a leave failure", async () => {
    const player = fakePlayer();
    let leaveCalls = 0;
    let releaseFirstLeave: (() => void) | undefined;
    const firstLeave = new Promise<void>((resolve) => {
      releaseFirstLeave = resolve;
    });
    const client = {
      async joinVoiceChannel() {
        return player as unknown as Player;
      },
      async leaveVoiceChannel() {
        leaveCalls += 1;
        if (leaveCalls === 1) {
          await firstLeave;
          throw new Error("transient leave failure");
        }
      },
    } as unknown as Shoukaku;
    const session = await createShoukakuPlaybackTransport(client).join({
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      shardId: 0,
      initialVolume: 70,
      callbacks: callbacks([]),
    });

    const firstDestroy = session.destroy();
    const concurrentDestroy = session.destroy();
    assert.equal(leaveCalls, 1);
    releaseFirstLeave?.();
    await assert.rejects(Promise.all([firstDestroy, concurrentDestroy]), /transient leave failure/);

    await session.destroy();
    await session.destroy();
    assert.equal(leaveCalls, 2);
  });
});
