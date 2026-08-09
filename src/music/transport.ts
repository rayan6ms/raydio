export type PlaybackEndReason = "finished" | "loadFailed" | "stopped" | "replaced" | "cleanup";

export interface PlaybackSessionCallbacks {
  onStart(encodedTrack: string): void;
  onEnd(encodedTrack: string, reason: PlaybackEndReason): void;
  onException(encodedTrack: string | null, severity: string): void;
  onStuck(encodedTrack: string, thresholdMs: number): void;
  onClosed(code: number, byRemote: boolean): void;
}

export interface PlaybackJoinOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly shardId: number;
  readonly initialVolume: number;
  readonly callbacks: PlaybackSessionCallbacks;
}

export interface PlaybackSession {
  play(encodedTrack: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setVolume(volume: number): Promise<void>;
  stop(): Promise<void>;
  getPositionMs(): number;
  destroy(): Promise<void>;
}

export interface PlaybackTransport {
  join(options: PlaybackJoinOptions): Promise<PlaybackSession>;
}
