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
): PlaybackSession {
  const onStart = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackStartEvent") {
      options.callbacks.onStart(event.track.encoded);
    }
  };
  const onEnd = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackEndEvent") {
      options.callbacks.onEnd(event.track.encoded, event.reason);
    }
  };
  const onStuck = (event: Parameters<Player["onPlayerEvent"]>[0]): void => {
    if (event.type === "TrackStuckEvent") {
      options.callbacks.onStuck(event.track.encoded, event.thresholdMs);
    }
  };
  const onException = (event: TrackExceptionEvent): void => {
    const compatibleEvent = event as ExceptionEventWithTrack;
    options.callbacks.onException(
      compatibleEvent.track?.encoded ?? player.track,
      event.exception.severity,
    );
  };
  const onClosed = (event: { readonly code: number; readonly byRemote: boolean }): void => {
    options.callbacks.onClosed(event.code, event.byRemote);
  };

  player.on("start", onStart);
  player.on("end", onEnd);
  player.on("stuck", onStuck);
  player.on("exception", onException);
  player.on("closed", onClosed);

  let destroyed = false;
  return {
    play(encodedTrack) {
      if (destroyed) {
        return Promise.reject(new Error("Playback session has been destroyed"));
      }
      return player.playTrack({ track: { encoded: encodedTrack } });
    },
    setPaused(paused) {
      if (destroyed) {
        return Promise.reject(new Error("Playback session has been destroyed"));
      }
      return player.setPaused(paused);
    },
    setVolume(volume) {
      if (destroyed) {
        return Promise.reject(new Error("Playback session has been destroyed"));
      }
      return player.setGlobalVolume(volume);
    },
    stop() {
      if (destroyed) {
        return Promise.resolve();
      }
      return player.stopTrack();
    },
    getPositionMs() {
      return Number.isFinite(player.position) && player.position >= 0 ? player.position : 0;
    },
    async destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      player.off("start", onStart);
      player.off("end", onEnd);
      player.off("stuck", onStuck);
      player.off("exception", onException);
      player.off("closed", onClosed);
      await client.leaveVoiceChannel(options.guildId);
    },
  };
}

export function createShoukakuPlaybackTransport(client: Shoukaku): PlaybackTransport {
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
        return createSession(client, player, options);
      } catch (error: unknown) {
        await client.leaveVoiceChannel(options.guildId).catch(() => undefined);
        throw error;
      }
    },
  };
}
