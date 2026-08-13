import type { Player, Shoukaku, Track, TrackExceptionEvent } from "shoukaku";

import type { PlaybackJoinOptions, PlaybackSession, PlaybackTransport } from "./transport.js";

interface ShoukakuVoiceClient {
  joinVoiceChannel(options: {
    readonly guildId: string;
    readonly channelId: string;
    readonly shardId: number;
    readonly deaf: boolean;
    readonly mute: boolean;
  }): Promise<Player>;
  leaveVoiceChannel(guildId: string): Promise<void>;
}

type ExceptionEventWithTrack = TrackExceptionEvent & { readonly track?: Track };

function createSession(
  client: ShoukakuVoiceClient,
  player: Player,
  options: PlaybackJoinOptions,
  now: () => number,
): PlaybackSession {
  let basePositionMs = 0;
  let positionUpdatedAtMs = now();
  let playing = false;
  let paused = false;
  let connected: boolean | null = null;
  let lastPlayerUpdateAtMs: number | null = null;
  let lastEventAtMs: number | null = null;

  function estimatedPositionMs(): number {
    const elapsedMs = playing && !paused ? Math.max(0, now() - positionUpdatedAtMs) : 0;
    return Math.max(0, basePositionMs + elapsedMs);
  }

  const onStart = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackStartEvent") {
      lastEventAtMs = now();
      basePositionMs = 0;
      positionUpdatedAtMs = now();
      playing = true;
      paused = false;
      options.callbacks.onStart(event.track.encoded);
    }
  };
  const onEnd = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackEndEvent") {
      lastEventAtMs = now();
      basePositionMs = estimatedPositionMs();
      positionUpdatedAtMs = now();
      playing = false;
      options.callbacks.onEnd(event.track.encoded, event.reason);
    }
  };
  const onUpdate = (event: Parameters<Player["onPlayerUpdate"]>[0]): void => {
    lastPlayerUpdateAtMs = now();
    connected = event.state.connected;
    const position = event.state.position;
    if (Number.isFinite(position) && position >= 0) {
      basePositionMs = position;
      positionUpdatedAtMs = now();
      playing = player.track !== null;
      paused = player.paused;
    }
  };
  const onStuck = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackStuckEvent") {
      lastEventAtMs = now();
      options.callbacks.onStuck(event.track.encoded, event.thresholdMs);
    }
  };
  const onException = (event: TrackExceptionEvent): void => {
    lastEventAtMs = now();
    const compatibleEvent = event as ExceptionEventWithTrack;
    options.callbacks.onException(
      compatibleEvent.track?.encoded ?? player.track,
      event.exception.severity,
    );
  };
  const onClosed = (event: { readonly code: number; readonly byRemote: boolean }): void => {
    lastEventAtMs = now();
    connected = false;
    options.callbacks.onClosed(event.code, event.byRemote);
  };

  player.on("start", onStart);
  player.on("end", onEnd);
  player.on("update", onUpdate);
  player.on("stuck", onStuck);
  player.on("exception", onException);
  player.on("closed", onClosed);

  let destroyed = false;
  let destroyPromise: Promise<void> | undefined;
  return {
    async play(encodedTrack) {
      if (destroyed) {
        throw new Error("Playback session has been destroyed");
      }
      await player.playTrack({ track: { encoded: encodedTrack } });
      basePositionMs = 0;
      positionUpdatedAtMs = now();
      playing = true;
      paused = false;
    },
    async setPaused(nextPaused) {
      if (destroyed) {
        throw new Error("Playback session has been destroyed");
      }
      const position = estimatedPositionMs();
      await player.setPaused(nextPaused);
      basePositionMs = position;
      positionUpdatedAtMs = now();
      paused = nextPaused;
    },
    setVolume(volume) {
      if (destroyed) {
        return Promise.reject(new Error("Playback session has been destroyed"));
      }
      return player.setGlobalVolume(volume);
    },
    async stop() {
      if (destroyed) {
        return;
      }
      await player.stopTrack();
      basePositionMs = estimatedPositionMs();
      positionUpdatedAtMs = now();
      playing = false;
    },
    getPositionMs() {
      return estimatedPositionMs();
    },
    getHealth() {
      return {
        connected,
        playing,
        paused,
        lastPlayerUpdateAtMs,
        lastEventAtMs,
      };
    },
    destroy() {
      if (destroyPromise !== undefined) {
        return destroyPromise;
      }

      if (!destroyed) {
        destroyed = true;
        player.off("start", onStart);
        player.off("end", onEnd);
        player.off("update", onUpdate);
        player.off("stuck", onStuck);
        player.off("exception", onException);
        player.off("closed", onClosed);
      }

      destroyPromise = client.leaveVoiceChannel(options.guildId).catch((error: unknown) => {
        destroyPromise = undefined;
        throw error;
      });
      return destroyPromise;
    },
  };
}

export function createShoukakuPlaybackTransport(
  client: Shoukaku,
  now: () => number = Date.now,
): PlaybackTransport {
  return {
    async join(options) {
      const player = await client.joinVoiceChannel({
        guildId: options.guildId,
        channelId: options.voiceChannelId,
        shardId: options.shardId,
        deaf: true,
        mute: false,
      });

      try {
        await player.setGlobalVolume(options.initialVolume);
        return createSession(client, player, options, now);
      } catch (error: unknown) {
        await client.leaveVoiceChannel(options.guildId).catch(() => undefined);
        throw error;
      }
    },
  };
}
