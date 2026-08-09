import type { ResolvedTrack } from "./resolver.js";

export type LoopMode = "off" | "track" | "queue";
export type PlayerToken = symbol;

export interface TrackRequester {
  readonly id: string;
  readonly label: string;
}

export interface QueueTrack extends ResolvedTrack {
  readonly requestedBy: TrackRequester;
}

export interface GuildPlaybackSnapshot {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly notificationChannelId: string;
  readonly playerToken: PlayerToken;
  readonly current: QueueTrack | null;
  readonly upcoming: readonly QueueTrack[];
  readonly loopMode: LoopMode;
  readonly volume: number;
  readonly paused: boolean;
  readonly positionMs: number;
  readonly consecutiveFailures: number;
  readonly alone: boolean;
}

export function toQueueTrack(track: ResolvedTrack, requestedBy: TrackRequester): QueueTrack {
  return {
    encoded: track.encoded,
    identifier: track.identifier,
    title: track.title,
    author: track.author,
    durationMs: track.durationMs,
    isStream: track.isStream,
    uri: track.uri,
    sourceName: track.sourceName,
    requestedBy: {
      id: requestedBy.id,
      label: requestedBy.label,
    },
  };
}

export function copyQueueTrack(track: QueueTrack): QueueTrack {
  return {
    ...track,
    requestedBy: { ...track.requestedBy },
  };
}
