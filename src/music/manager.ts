import type { Logger } from "pino";

import type { Config } from "../config.js";
import { errorFields } from "../utils.js";
import type { LavalinkSessionInvalidationReason } from "./lavalink.js";
import type { ResolveResult, SearchResolveResult, TrackResolver } from "./resolver.js";
import { KeyedSerialExecutor } from "./serial.js";
import {
  copyQueueTrack,
  type GuildPlaybackIdentity,
  type GuildPlaybackSnapshot,
  type LoopMode,
  type PlayerToken,
  type QueueTrack,
  type TrackRequester,
  toQueueTrack,
} from "./state.js";
import type {
  PlaybackEndReason,
  PlaybackSession,
  PlaybackSessionCallbacks,
  PlaybackSessionHealth,
  PlaybackTransport,
} from "./transport.js";
import type { VoiceAccessResult } from "./voice.js";

const MILLISECONDS_PER_SECOND = 1_000;
const FAILURE_LIMIT = 3;
const HISTORY_LIMIT = 20;
const TRACK_END_GRACE_MS = 15_000;
const DIAGNOSTIC_GUILD_LIMIT = 1_000;

export const PLAYBACK_DIAGNOSTIC_EVENTS = [
  "queue-updated",
  "playback-transition",
  "track-started",
  "track-end-finished",
  "track-end-failed",
  "track-end-watchdog",
  "track-exception",
  "track-stuck",
  "transport-failed",
  "session-cleaned",
] as const;

export type PlaybackDiagnosticEvent = (typeof PLAYBACK_DIAGNOSTIC_EVENTS)[number];

export interface PlaybackChange {
  readonly guildId: string;
  readonly reason: PlaybackDiagnosticEvent;
  readonly sequence: number;
}

export interface PlaybackDiagnostics {
  readonly guildId: string;
  readonly sessionActive: boolean;
  readonly hasCurrentTrack: boolean;
  readonly paused: boolean;
  readonly upcomingTrackCount: number;
  readonly historyCount: number;
  readonly loopMode: LoopMode | null;
  readonly volume: number | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly isStream: boolean;
  readonly lastEvent: PlaybackDiagnosticEvent | null;
  readonly lastEventAtMs: number | null;
  readonly eventCounts: Readonly<Record<PlaybackDiagnosticEvent, number>>;
  readonly transport: PlaybackSessionHealth | null;
}

export type TrackEndReason = PlaybackEndReason;

export interface TimerHandle {
  unref?(): void;
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface PlayRequest {
  readonly guildId: string;
  readonly notificationChannelId: string;
  readonly intendedVoiceChannelId: string;
  readonly shardId: number;
  readonly input: string;
  readonly requestedBy: TrackRequester;
  readonly validateCommit: () => VoiceAccessResult;
}

export interface SearchTracksRequest {
  readonly guildId: string;
  readonly intendedVoiceChannelId: string;
  readonly input: string;
  readonly resultLimit: number;
}

export interface PlaybackControlRequest {
  readonly guildId: string;
  readonly intendedVoiceChannelId: string;
  readonly playerToken: PlayerToken | null;
  readonly validateCommit: () => boolean;
}

export type ControlRejectionReason =
  | "no-session"
  | "stale-session"
  | "wrong-channel"
  | "voice-changed";

export type ControlResult<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "rejected"; readonly reason: ControlRejectionReason }
  | { readonly kind: "transport-failed" };

type UnqueuedResolution = Exclude<ResolveResult, { kind: "tracks" }>;

export type PlayRequestResult =
  | {
      readonly kind: "queued";
      readonly addedTrackCount: number;
      readonly becameCurrent: boolean;
      readonly rejectedTrackCount: number;
      readonly truncatedTrackCount: number;
      readonly commitTruncatedTrackCount: number;
      readonly playlistName: string | null;
      readonly firstTrack: QueueTrack;
    }
  | { readonly kind: "not-queued"; readonly resolution: UnqueuedResolution }
  | { readonly kind: "pending-limit" }
  | { readonly kind: "stale" }
  | { readonly kind: "commit-rejected"; readonly reason: VoiceAccessResult }
  | { readonly kind: "wrong-channel" }
  | { readonly kind: "queue-full" }
  | { readonly kind: "join-failed" }
  | { readonly kind: "play-failed" }
  | { readonly kind: "closed" };

export type SearchTracksResult =
  | SearchResolveResult
  | { readonly kind: "pending-limit" }
  | { readonly kind: "queue-full" }
  | { readonly kind: "stale" }
  | { readonly kind: "wrong-channel" }
  | { readonly kind: "closed" };

export type TransitionResult =
  | { readonly kind: "advanced"; readonly current: QueueTrack | null }
  | { readonly kind: "replayed"; readonly current: QueueTrack }
  | { readonly kind: "failure-guard" }
  | {
      readonly kind: "ignored";
      readonly reason: "no-state" | "no-current" | "stale-session" | "stale-track" | "end-reason";
    };

export interface PlayerEventIdentity {
  readonly guildId: string;
  readonly playerToken: PlayerToken;
  readonly encodedTrack: string;
}

export interface MusicManager {
  getIdentity(guildId: string): GuildPlaybackIdentity | undefined;
  getIdentities(): readonly GuildPlaybackIdentity[];
  getSnapshot(guildId: string): GuildPlaybackSnapshot | undefined;
  getDiagnostics(guildId: string): PlaybackDiagnostics;
  getPendingPlayRequestCount(guildId: string): number;
  onPlaybackChanged(listener: (change: PlaybackChange) => void): () => void;
  searchTracks(request: SearchTracksRequest): Promise<SearchTracksResult>;
  requestPlay(request: PlayRequest): Promise<PlayRequestResult>;
  setPaused(
    request: PlaybackControlRequest,
    paused: boolean,
  ): Promise<ControlResult<"updated" | "unchanged" | "no-current">>;
  setVolume(
    request: PlaybackControlRequest,
    volume: number,
  ): Promise<ControlResult<{ readonly volume: number; readonly changed: boolean }>>;
  setLoopMode(
    request: PlaybackControlRequest,
    loopMode: LoopMode,
  ): Promise<ControlResult<LoopMode>>;
  removeUpcoming(
    request: PlaybackControlRequest,
    displayedIndex: number,
  ): Promise<ControlResult<QueueTrack | null>>;
  moveUpcoming(
    request: PlaybackControlRequest,
    fromIndex: number,
    toIndex: number,
  ): Promise<ControlResult<{ readonly track: QueueTrack; readonly changed: boolean } | null>>;
  clearUpcoming(request: PlaybackControlRequest): Promise<ControlResult<number>>;
  shuffleUpcoming(request: PlaybackControlRequest): Promise<ControlResult<boolean>>;
  jump(
    request: PlaybackControlRequest,
    displayedIndex: number,
  ): Promise<ControlResult<TransitionResult | null>>;
  previous(request: PlaybackControlRequest): Promise<ControlResult<QueueTrack | null>>;
  skip(request: PlaybackControlRequest): Promise<ControlResult<TransitionResult>>;
  stop(request: PlaybackControlRequest): Promise<ControlResult<"stopped" | "unchanged">>;
  leave(request: PlaybackControlRequest): Promise<ControlResult<boolean>>;
  cleanupUnexpected(guildId: string): Promise<boolean>;
  handleLavalinkInvalidation(reason: LavalinkSessionInvalidationReason): Promise<number>;
  handleTrackEnd(
    event: PlayerEventIdentity & { readonly reason: TrackEndReason },
  ): Promise<TransitionResult>;
  handleTrackException(event: PlayerEventIdentity): Promise<TransitionResult>;
  handleTrackStuck(event: PlayerEventIdentity): Promise<TransitionResult>;
  updateAloneStatus(guildId: string, playerToken: PlayerToken, alone: boolean): Promise<boolean>;
  stopService(): Promise<void>;
}

type ManagerConfig = Pick<
  Config["playback"],
  | "aloneDisconnectSeconds"
  | "defaultVolume"
  | "idleDisconnectSeconds"
  | "maxPendingPlayRequests"
  | "maxQueueTracks"
>;

interface GuildCoordinator {
  epoch: number;
  pendingPlayRequests: number;
}

interface GuildPlaybackState {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly notificationChannelId: string;
  readonly playerToken: PlayerToken;
  current: QueueTrack | null;
  upcoming: QueueTrack[];
  history: QueueTrack[];
  loopMode: LoopMode;
  volume: number;
  paused: boolean;
  consecutiveFailures: number;
  alone: boolean;
  idleTimer: TimerHandle | null;
  aloneTimer: TimerHandle | null;
  trackEndTimer: TimerHandle | null;
  readonly session: PlaybackSession;
}

interface MusicManagerDependencies {
  readonly resolver: TrackResolver;
  readonly transport: PlaybackTransport;
  readonly logger: Logger;
  readonly notifier?: {
    send(channelId: string, content: string): Promise<void>;
  };
  readonly scheduler?: TimerScheduler;
  readonly random?: () => number;
  readonly createPlayerToken?: () => PlayerToken;
  readonly now?: () => number;
}

interface DiagnosticRecord {
  lastEvent: PlaybackDiagnosticEvent | null;
  lastEventAtMs: number | null;
  sequence: number;
  readonly eventCounts: Record<PlaybackDiagnosticEvent, number>;
}

type CleanupReason =
  | "alone-timeout"
  | "idle-timeout"
  | "initial-play-failed"
  | "lavalink-session-lost"
  | "lavalink-unavailable"
  | "leave"
  | "shutdown"
  | "unexpected-voice-change"
  | "voice-closed";

const CLEANUP_NOTIFICATIONS: Partial<Record<CleanupReason, string>> = {
  "alone-timeout": "Left the voice channel because no listeners remained.",
  "idle-timeout": "Left the voice channel after the queue stayed idle.",
  "lavalink-session-lost": "Playback ended because Lavalink restarted. Use `/play` to start again.",
  "lavalink-unavailable":
    "Playback ended because Lavalink became unavailable. Use `/play` after it recovers.",
  "unexpected-voice-change": "Playback ended because the bot was moved or disconnected.",
  "voice-closed": "Playback ended because Discord closed the voice connection.",
};

const defaultScheduler: TimerScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function validVolume(value: number, name = "volume"): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be a safe integer between 0 and 100`);
  }
}

function durationMs(seconds: number, name: string): number {
  positiveSafeInteger(seconds, name);
  const milliseconds = seconds * MILLISECONDS_PER_SECOND;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`${name} is too large to convert safely`);
  }
  return milliseconds;
}

function copySnapshot(state: GuildPlaybackState): GuildPlaybackSnapshot {
  return {
    guildId: state.guildId,
    voiceChannelId: state.voiceChannelId,
    notificationChannelId: state.notificationChannelId,
    playerToken: state.playerToken,
    current: state.current === null ? null : copyQueueTrack(state.current),
    upcoming: state.upcoming.map(copyQueueTrack),
    historyCount: state.history.length,
    loopMode: state.loopMode,
    volume: state.volume,
    paused: state.paused,
    positionMs: state.current === null ? 0 : state.session.getPositionMs(),
    consecutiveFailures: state.consecutiveFailures,
    alone: state.alone,
  };
}

function copyIdentity(state: GuildPlaybackState): GuildPlaybackIdentity {
  return {
    guildId: state.guildId,
    voiceChannelId: state.voiceChannelId,
    playerToken: state.playerToken,
  };
}

function queueSize(state: GuildPlaybackState | undefined): number {
  if (state === undefined) {
    return 0;
  }
  return state.upcoming.length + (state.current === null ? 0 : 1);
}

function emptyEventCounts(): Record<PlaybackDiagnosticEvent, number> {
  return Object.fromEntries(PLAYBACK_DIAGNOSTIC_EVENTS.map((event) => [event, 0])) as Record<
    PlaybackDiagnosticEvent,
    number
  >;
}

export function createMusicManager(
  config: ManagerConfig,
  dependencies: MusicManagerDependencies,
): MusicManager {
  positiveSafeInteger(config.maxQueueTracks, "maxQueueTracks");
  positiveSafeInteger(config.maxPendingPlayRequests, "maxPendingPlayRequests");
  validVolume(config.defaultVolume, "defaultVolume");
  const idleDelayMs = durationMs(config.idleDisconnectSeconds, "idleDisconnectSeconds");
  const aloneDelayMs = durationMs(config.aloneDisconnectSeconds, "aloneDisconnectSeconds");

  const states = new Map<string, GuildPlaybackState>();
  const coordinators = new Map<string, GuildCoordinator>();
  const stateExecutor = new KeyedSerialExecutor<string>();
  const playExecutor = new KeyedSerialExecutor<string>();
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const random = dependencies.random ?? Math.random;
  const createPlayerToken = dependencies.createPlayerToken ?? (() => Symbol("player"));
  const now = dependencies.now ?? Date.now;
  const diagnosticRecords = new Map<string, DiagnosticRecord>();
  const playbackChangeListeners = new Set<(change: PlaybackChange) => void>();
  let acceptingPlayRequests = true;

  function diagnosticRecord(guildId: string): DiagnosticRecord {
    const existing = diagnosticRecords.get(guildId);
    if (existing !== undefined) {
      diagnosticRecords.delete(guildId);
      diagnosticRecords.set(guildId, existing);
      return existing;
    }
    if (diagnosticRecords.size >= DIAGNOSTIC_GUILD_LIMIT) {
      const oldestGuildId = diagnosticRecords.keys().next().value;
      if (oldestGuildId !== undefined) {
        diagnosticRecords.delete(oldestGuildId);
      }
    }
    const created: DiagnosticRecord = {
      lastEvent: null,
      lastEventAtMs: null,
      sequence: 0,
      eventCounts: emptyEventCounts(),
    };
    diagnosticRecords.set(guildId, created);
    return created;
  }

  function recordPlaybackEvent(guildId: string, event: PlaybackDiagnosticEvent): number {
    const record = diagnosticRecord(guildId);
    record.eventCounts[event] += 1;
    if (event !== "playback-transition") {
      record.lastEvent = event;
      record.lastEventAtMs = now();
    }
    record.sequence += 1;
    return record.sequence;
  }

  function publishPlaybackChange(guildId: string, reason: PlaybackDiagnosticEvent): void {
    const sequence = recordPlaybackEvent(guildId, reason);
    for (const listener of playbackChangeListeners) {
      try {
        listener({ guildId, reason, sequence });
      } catch (error: unknown) {
        dependencies.logger.warn(
          { event: "playback_change_listener_failed", guildId, ...errorFields(error) },
          "A playback change listener failed",
        );
      }
    }
  }

  function coordinatorFor(guildId: string): GuildCoordinator {
    const existing = coordinators.get(guildId);
    if (existing !== undefined) {
      return existing;
    }

    const coordinator = { epoch: 0, pendingPlayRequests: 0 };
    coordinators.set(guildId, coordinator);
    return coordinator;
  }

  function discardCoordinatorIfIdle(guildId: string, coordinator: GuildCoordinator): void {
    if (
      coordinator.pendingPlayRequests === 0 &&
      !states.has(guildId) &&
      coordinators.get(guildId) === coordinator
    ) {
      coordinators.delete(guildId);
    }
  }

  function cancelTimer(timer: TimerHandle | null): void {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
    }
  }

  function cancelStateTimers(state: GuildPlaybackState): void {
    cancelTimer(state.idleTimer);
    cancelTimer(state.aloneTimer);
    cancelTimer(state.trackEndTimer);
    state.idleTimer = null;
    state.aloneTimer = null;
    state.trackEndTimer = null;
  }

  function invalidate(guildId: string): GuildCoordinator {
    const coordinator = coordinatorFor(guildId);
    coordinator.epoch += 1;
    return coordinator;
  }

  async function deleteState(
    guildId: string,
    state: GuildPlaybackState,
    reason: CleanupReason,
  ): Promise<boolean> {
    if (states.get(guildId) !== state) {
      return false;
    }

    const coordinator = invalidate(guildId);
    cancelStateTimers(state);
    states.delete(guildId);
    discardCoordinatorIfIdle(guildId, coordinator);
    publishPlaybackChange(guildId, "session-cleaned");
    try {
      await state.session.destroy();
    } catch (firstError: unknown) {
      dependencies.logger.warn(
        { event: "player_destroy_retry", guildId, ...errorFields(firstError) },
        "Retrying playback session cleanup",
      );
      try {
        await state.session.destroy();
      } catch (error: unknown) {
        dependencies.logger.warn(
          { event: "player_destroy_failed", guildId, ...errorFields(error) },
          "Could not destroy playback session cleanly",
        );
      }
    }
    dependencies.logger.info(
      {
        event: "playback_session_cleaned",
        guildId,
        voiceChannelId: state.voiceChannelId,
        reason,
      },
      "Playback session cleaned up",
    );
    const notification = CLEANUP_NOTIFICATIONS[reason];
    if (notification !== undefined && dependencies.notifier !== undefined) {
      void dependencies.notifier
        .send(state.notificationChannelId, notification)
        .catch((error: unknown) => {
          dependencies.logger.warn(
            {
              event: "playback_cleanup_notification_failed",
              guildId,
              reason,
              ...errorFields(error),
            },
            "Could not send the playback cleanup notification",
          );
        });
    }
    return true;
  }

  function scheduleIdleTimer(state: GuildPlaybackState): void {
    if (state.current !== null || state.upcoming.length > 0 || state.idleTimer !== null) {
      return;
    }

    let handle: TimerHandle;
    handle = scheduler.setTimeout(() => {
      void stateExecutor
        .run(state.guildId, async () => {
          const active = states.get(state.guildId);
          if (
            active !== state ||
            active.idleTimer !== handle ||
            active.current !== null ||
            active.upcoming.length > 0
          ) {
            return;
          }

          active.idleTimer = null;
          await deleteState(state.guildId, active, "idle-timeout");
        })
        .catch((error: unknown) => {
          dependencies.logger.error(
            { event: "idle_cleanup_failed", guildId: state.guildId, errorType: typeof error },
            "Idle cleanup failed",
          );
        });
    }, idleDelayMs);
    state.idleTimer = handle;
    handle.unref?.();
  }

  function scheduleAloneTimer(state: GuildPlaybackState): void {
    if (!state.alone || state.aloneTimer !== null) {
      return;
    }

    let handle: TimerHandle;
    handle = scheduler.setTimeout(() => {
      void stateExecutor
        .run(state.guildId, async () => {
          const active = states.get(state.guildId);
          if (active !== state || active.aloneTimer !== handle || !active.alone) {
            return;
          }

          active.aloneTimer = null;
          await deleteState(state.guildId, active, "alone-timeout");
        })
        .catch((error: unknown) => {
          dependencies.logger.error(
            { event: "alone_cleanup_failed", guildId: state.guildId, errorType: typeof error },
            "Alone cleanup failed",
          );
        });
    }, aloneDelayMs);
    state.aloneTimer = handle;
    handle.unref?.();
  }

  function scheduleTrackEndTimer(state: GuildPlaybackState): void {
    cancelTimer(state.trackEndTimer);
    state.trackEndTimer = null;
    const track = state.current;
    if (track === null || track.isStream || state.paused) {
      return;
    }

    const positionMs = Math.max(0, state.session.getPositionMs());
    const remainingMs = Math.max(0, track.durationMs - positionMs);
    let handle: TimerHandle;
    handle = scheduler.setTimeout(() => {
      void stateExecutor
        .run(state.guildId, async () => {
          const active = states.get(state.guildId);
          if (
            active !== state ||
            active.trackEndTimer !== handle ||
            active.current !== track ||
            active.paused
          ) {
            return;
          }

          active.trackEndTimer = null;
          dependencies.logger.warn(
            {
              event: "track_end_watchdog",
              guildId: state.guildId,
              trackIdentifier: track.identifier,
            },
            "Advancing because Lavalink did not report the track ending",
          );
          recordPlaybackEvent(state.guildId, "track-end-watchdog");
          const result = transitionCurrent(active, "finished");
          await applyPlaybackEffect(active, result);
        })
        .catch((error: unknown) =>
          reportEventFailure(state.guildId, "track_end_watchdog_failed", error),
        );
    }, remainingMs + TRACK_END_GRACE_MS);
    state.trackEndTimer = handle;
    handle.unref?.();
  }

  function setCurrentAfterTransition(state: GuildPlaybackState, next: QueueTrack | null): void {
    cancelTimer(state.trackEndTimer);
    state.trackEndTimer = null;
    state.current = next;
    state.paused = false;
    if (next === null) {
      scheduleIdleTimer(state);
    } else {
      cancelTimer(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function rememberTrack(state: GuildPlaybackState, track: QueueTrack): void {
    state.history.push(copyQueueTrack(track));
    if (state.history.length > HISTORY_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
  }

  function transitionCurrent(
    state: GuildPlaybackState,
    cause: "finished" | "manual-skip" | "failure",
  ): TransitionResult {
    const finished = state.current;
    if (finished === null) {
      return { kind: "ignored", reason: "no-current" };
    }

    if (cause === "finished") {
      state.consecutiveFailures = 0;
      if (state.loopMode === "track") {
        setCurrentAfterTransition(state, finished);
        return { kind: "replayed", current: copyQueueTrack(finished) };
      }
      if (state.loopMode === "queue") {
        state.upcoming.push(finished);
      }
    } else if (cause === "failure") {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= FAILURE_LIMIT) {
        state.upcoming = [];
        setCurrentAfterTransition(state, null);
        return { kind: "failure-guard" };
      }
    }

    if (cause !== "failure") {
      rememberTrack(state, finished);
    }

    const next = state.upcoming.shift() ?? null;
    setCurrentAfterTransition(state, next);
    return { kind: "advanced", current: next === null ? null : copyQueueTrack(next) };
  }

  function validateEvent(
    event: PlayerEventIdentity,
    capturedState: GuildPlaybackState | undefined,
    capturedCurrent: QueueTrack | null | undefined,
  ): { readonly state: GuildPlaybackState } | { readonly result: TransitionResult } {
    const state = states.get(event.guildId);
    if (state === undefined) {
      return { result: { kind: "ignored", reason: "no-state" } };
    }
    if (state.playerToken !== event.playerToken) {
      return { result: { kind: "ignored", reason: "stale-session" } };
    }
    if (
      state !== capturedState ||
      state.current !== capturedCurrent ||
      state.current?.encoded !== event.encodedTrack
    ) {
      return { result: { kind: "ignored", reason: "stale-track" } };
    }
    return { state };
  }

  function validateControl(
    request: PlaybackControlRequest,
  ): { readonly state: GuildPlaybackState } | { readonly result: ControlResult<never> } {
    const state = states.get(request.guildId);
    if (state === undefined) {
      return { result: { kind: "rejected", reason: "no-session" } };
    }
    if (state.playerToken !== request.playerToken) {
      return { result: { kind: "rejected", reason: "stale-session" } };
    }
    if (state.voiceChannelId !== request.intendedVoiceChannelId) {
      return { result: { kind: "rejected", reason: "wrong-channel" } };
    }
    if (!request.validateCommit()) {
      return { result: { kind: "rejected", reason: "voice-changed" } };
    }
    return { state };
  }

  async function applyPlaybackEffect(
    state: GuildPlaybackState,
    initialResult: TransitionResult,
  ): Promise<TransitionResult> {
    let result = initialResult;
    while (result.kind === "advanced" || result.kind === "replayed") {
      if (result.current === null) {
        publishPlaybackChange(state.guildId, "playback-transition");
        return result;
      }

      try {
        await state.session.play(result.current.encoded);
        scheduleTrackEndTimer(state);
        publishPlaybackChange(state.guildId, "playback-transition");
        return result;
      } catch (error: unknown) {
        recordPlaybackEvent(state.guildId, "transport-failed");
        dependencies.logger.warn(
          {
            event: "track_play_failed",
            guildId: state.guildId,
            trackIdentifier: result.current.identifier,
            ...errorFields(error),
          },
          "Could not start the selected track",
        );
        result = transitionCurrent(state, "failure");
      }
    }
    if (result.kind === "failure-guard") {
      publishPlaybackChange(state.guildId, "playback-transition");
      dependencies.logger.warn(
        { event: "playback_failure_guard", guildId: state.guildId },
        "Automatic playback stopped after consecutive failures",
      );
      void dependencies.notifier
        ?.send(
          state.notificationChannelId,
          "Playback stopped after three consecutive track failures. The source may be unhealthy.",
        )
        .catch((error: unknown) => {
          dependencies.logger.warn(
            {
              event: "failure_guard_notification_failed",
              guildId: state.guildId,
              ...errorFields(error),
            },
            "Could not send the playback failure warning",
          );
        });
    }
    return result;
  }

  async function stopPlaybackBestEffort(state: GuildPlaybackState): Promise<void> {
    cancelTimer(state.trackEndTimer);
    state.trackEndTimer = null;
    try {
      await state.session.stop();
    } catch (error: unknown) {
      recordPlaybackEvent(state.guildId, "transport-failed");
      dependencies.logger.warn(
        { event: "player_stop_failed", guildId: state.guildId, ...errorFields(error) },
        "Could not stop the current transport track cleanly",
      );
    }
  }

  function reportEventFailure(guildId: string, event: string, error: unknown): void {
    dependencies.logger.error(
      { event, guildId, ...errorFields(error) },
      "Playback event handling failed",
    );
  }

  function handleTrackStartInternal(event: PlayerEventIdentity): Promise<void> {
    const capturedState = states.get(event.guildId);
    const capturedCurrent = capturedState?.current;
    return stateExecutor.run(event.guildId, () => {
      const validation = validateEvent(event, capturedState, capturedCurrent);
      if ("result" in validation) {
        return;
      }
      scheduleTrackEndTimer(validation.state);
      publishPlaybackChange(event.guildId, "track-started");
      dependencies.logger.info(
        {
          event: "track_started",
          guildId: event.guildId,
          trackIdentifier: validation.state.current?.identifier,
        },
        "Track started",
      );
    });
  }

  function handleTrackEndInternal(
    event: PlayerEventIdentity & { readonly reason: TrackEndReason },
  ): Promise<TransitionResult> {
    const capturedState = states.get(event.guildId);
    const capturedCurrent = capturedState?.current;
    return stateExecutor.run(event.guildId, async () => {
      if (event.reason === "stopped" || event.reason === "replaced" || event.reason === "cleanup") {
        const state = states.get(event.guildId);
        if (state === undefined) {
          return { kind: "ignored", reason: "no-state" };
        }
        if (state.playerToken !== event.playerToken) {
          return { kind: "ignored", reason: "stale-session" };
        }
        return { kind: "ignored", reason: "end-reason" };
      }

      const validation = validateEvent(event, capturedState, capturedCurrent);
      if ("result" in validation) {
        return validation.result;
      }
      recordPlaybackEvent(
        event.guildId,
        event.reason === "finished" ? "track-end-finished" : "track-end-failed",
      );
      const result = transitionCurrent(
        validation.state,
        event.reason === "finished" ? "finished" : "failure",
      );
      return applyPlaybackEffect(validation.state, result);
    });
  }

  function handleTrackExceptionInternal(event: PlayerEventIdentity): Promise<TransitionResult> {
    const capturedState = states.get(event.guildId);
    const capturedCurrent = capturedState?.current;
    return stateExecutor.run(event.guildId, () => {
      const validation = validateEvent(event, capturedState, capturedCurrent);
      if ("result" in validation) {
        return validation.result;
      }
      recordPlaybackEvent(event.guildId, "track-exception");
      dependencies.logger.warn(
        {
          event: "track_exception",
          guildId: event.guildId,
          trackIdentifier: validation.state.current?.identifier,
        },
        "Player reported a track exception",
      );
      return { kind: "ignored", reason: "end-reason" };
    });
  }

  function handleTrackStuckInternal(event: PlayerEventIdentity): Promise<TransitionResult> {
    const capturedState = states.get(event.guildId);
    const capturedCurrent = capturedState?.current;
    return stateExecutor.run(event.guildId, async () => {
      const validation = validateEvent(event, capturedState, capturedCurrent);
      if ("result" in validation) {
        return validation.result;
      }
      recordPlaybackEvent(event.guildId, "track-stuck");
      dependencies.logger.warn(
        {
          event: "track_stuck",
          guildId: event.guildId,
          trackIdentifier: validation.state.current?.identifier,
        },
        "Player reported a stuck track",
      );
      await stopPlaybackBestEffort(validation.state);
      const result = transitionCurrent(validation.state, "failure");
      return applyPlaybackEffect(validation.state, result);
    });
  }

  function handleClosedInternal(
    guildId: string,
    playerToken: PlayerToken,
    code: number,
    byRemote: boolean,
  ): Promise<void> {
    return stateExecutor.run(guildId, async () => {
      const state = states.get(guildId);
      if (state === undefined || state.playerToken !== playerToken) {
        return;
      }
      dependencies.logger.warn(
        { event: "voice_websocket_closed", guildId, closeCode: code, byRemote },
        "Discord voice websocket closed",
      );
      await deleteState(guildId, state, "voice-closed");
    });
  }

  function sessionCallbacks(guildId: string, playerToken: PlayerToken): PlaybackSessionCallbacks {
    return {
      onStart(encodedTrack) {
        void handleTrackStartInternal({ guildId, playerToken, encodedTrack }).catch((error) =>
          reportEventFailure(guildId, "track_start_handler_failed", error),
        );
      },
      onEnd(encodedTrack, reason) {
        void handleTrackEndInternal({ guildId, playerToken, encodedTrack, reason }).catch((error) =>
          reportEventFailure(guildId, "track_end_handler_failed", error),
        );
      },
      onException(encodedTrack, severity) {
        if (encodedTrack === null) {
          dependencies.logger.warn(
            { event: "track_exception_without_track", guildId, severity },
            "Player reported a track exception without track identity",
          );
          return;
        }
        void handleTrackExceptionInternal({ guildId, playerToken, encodedTrack }).catch((error) =>
          reportEventFailure(guildId, "track_exception_handler_failed", error),
        );
      },
      onStuck(encodedTrack, thresholdMs) {
        dependencies.logger.warn(
          { event: "track_stuck_threshold", guildId, thresholdMs },
          "Track exceeded the stuck threshold",
        );
        void handleTrackStuckInternal({ guildId, playerToken, encodedTrack }).catch((error) =>
          reportEventFailure(guildId, "track_stuck_handler_failed", error),
        );
      },
      onClosed(code, byRemote) {
        void handleClosedInternal(guildId, playerToken, code, byRemote).catch((error) =>
          reportEventFailure(guildId, "voice_close_handler_failed", error),
        );
      },
    };
  }

  return {
    getIdentity(guildId) {
      const state = states.get(guildId);
      return state === undefined ? undefined : copyIdentity(state);
    },

    getIdentities() {
      return [...states.values()].map(copyIdentity);
    },

    getSnapshot(guildId) {
      const state = states.get(guildId);
      return state === undefined ? undefined : copySnapshot(state);
    },

    getDiagnostics(guildId) {
      const state = states.get(guildId);
      const record = diagnosticRecords.get(guildId);
      return {
        guildId,
        sessionActive: state !== undefined,
        hasCurrentTrack: state?.current !== null && state?.current !== undefined,
        paused: state?.paused ?? false,
        upcomingTrackCount: state?.upcoming.length ?? 0,
        historyCount: state?.history.length ?? 0,
        loopMode: state?.loopMode ?? null,
        volume: state?.volume ?? null,
        positionMs:
          state?.current === null || state === undefined ? 0 : state.session.getPositionMs(),
        durationMs: state?.current?.durationMs ?? null,
        isStream: state?.current?.isStream ?? false,
        lastEvent: record?.lastEvent ?? null,
        lastEventAtMs: record?.lastEventAtMs ?? null,
        eventCounts: { ...(record?.eventCounts ?? emptyEventCounts()) },
        transport: state?.session.getHealth() ?? null,
      };
    },

    getPendingPlayRequestCount(guildId) {
      return coordinators.get(guildId)?.pendingPlayRequests ?? 0;
    },

    onPlaybackChanged(listener) {
      playbackChangeListeners.add(listener);
      return () => playbackChangeListeners.delete(listener);
    },

    async searchTracks(request) {
      if (!acceptingPlayRequests) {
        return { kind: "closed" };
      }
      if (
        !Number.isSafeInteger(request.resultLimit) ||
        request.resultLimit < 1 ||
        request.resultLimit > 10
      ) {
        throw new RangeError("resultLimit must be a safe integer between 1 and 10");
      }
      const coordinator = coordinatorFor(request.guildId);
      if (coordinator.pendingPlayRequests >= config.maxPendingPlayRequests) {
        return { kind: "pending-limit" };
      }

      const capturedEpoch = coordinator.epoch;
      coordinator.pendingPlayRequests += 1;
      try {
        const preflight = await stateExecutor.run(request.guildId, () => {
          if (coordinator.epoch !== capturedEpoch) {
            return { kind: "stale" } as const;
          }
          const state = states.get(request.guildId);
          if (state !== undefined && state.voiceChannelId !== request.intendedVoiceChannelId) {
            return { kind: "wrong-channel" } as const;
          }
          return queueSize(state) >= config.maxQueueTracks
            ? ({ kind: "queue-full" } as const)
            : ({ kind: "ready" } as const);
        });
        if (preflight.kind !== "ready") {
          return preflight;
        }

        const result = await dependencies.resolver.search(request.input, request.resultLimit);
        return stateExecutor.run(request.guildId, () => {
          if (coordinator.epoch !== capturedEpoch) {
            return { kind: "stale" } as const;
          }
          const state = states.get(request.guildId);
          if (state !== undefined && state.voiceChannelId !== request.intendedVoiceChannelId) {
            return { kind: "wrong-channel" } as const;
          }
          if (queueSize(state) >= config.maxQueueTracks) {
            return { kind: "queue-full" } as const;
          }
          return result;
        });
      } finally {
        coordinator.pendingPlayRequests -= 1;
        discardCoordinatorIfIdle(request.guildId, coordinator);
      }
    },

    async requestPlay(request) {
      if (!acceptingPlayRequests) {
        return { kind: "closed" };
      }
      if (!Number.isSafeInteger(request.shardId) || request.shardId < 0) {
        throw new RangeError("shardId must be a nonnegative safe integer");
      }
      const coordinator = coordinatorFor(request.guildId);
      if (coordinator.pendingPlayRequests >= config.maxPendingPlayRequests) {
        return { kind: "pending-limit" };
      }

      const capturedEpoch = coordinator.epoch;
      coordinator.pendingPlayRequests += 1;

      try {
        return await playExecutor.run(request.guildId, async (): Promise<PlayRequestResult> => {
          const preflight = await stateExecutor.run(request.guildId, () => {
            if (coordinator.epoch !== capturedEpoch) {
              return { kind: "stale" } as const;
            }
            const state = states.get(request.guildId);
            if (state !== undefined && state.voiceChannelId !== request.intendedVoiceChannelId) {
              return { kind: "wrong-channel" } as const;
            }
            return {
              kind: "ready",
              availableCapacity: config.maxQueueTracks - queueSize(state),
            } as const;
          });

          if (preflight.kind !== "ready") {
            return preflight;
          }

          const resolution = await dependencies.resolver.resolve(
            request.input,
            preflight.availableCapacity,
          );
          if (resolution.kind !== "tracks") {
            return { kind: "not-queued", resolution };
          }

          return stateExecutor.run(request.guildId, async (): Promise<PlayRequestResult> => {
            if (coordinator.epoch !== capturedEpoch) {
              return { kind: "stale" };
            }
            const commitAccess = request.validateCommit();
            if (
              commitAccess.kind !== "ready" ||
              commitAccess.voiceChannelId !== request.intendedVoiceChannelId
            ) {
              return { kind: "commit-rejected", reason: commitAccess };
            }

            let state = states.get(request.guildId);
            if (state !== undefined && state.voiceChannelId !== request.intendedVoiceChannelId) {
              return { kind: "wrong-channel" };
            }

            const availableCapacity = config.maxQueueTracks - queueSize(state);
            if (availableCapacity === 0) {
              return { kind: "queue-full" };
            }

            const accepted = resolution.tracks.slice(0, availableCapacity);
            if (accepted.length === 0) {
              return { kind: "queue-full" };
            }

            let createdState = false;
            if (state === undefined) {
              const playerToken = createPlayerToken();
              let session: PlaybackSession;
              try {
                session = await dependencies.transport.join({
                  guildId: request.guildId,
                  voiceChannelId: request.intendedVoiceChannelId,
                  shardId: request.shardId,
                  initialVolume: config.defaultVolume,
                  callbacks: sessionCallbacks(request.guildId, playerToken),
                });
              } catch (error: unknown) {
                recordPlaybackEvent(request.guildId, "transport-failed");
                dependencies.logger.warn(
                  {
                    event: "player_join_failed",
                    guildId: request.guildId,
                    voiceChannelId: request.intendedVoiceChannelId,
                    ...errorFields(error),
                  },
                  "Could not create a playback session",
                );
                return { kind: "join-failed" };
              }
              state = {
                guildId: request.guildId,
                voiceChannelId: request.intendedVoiceChannelId,
                notificationChannelId: request.notificationChannelId,
                playerToken,
                current: null,
                upcoming: [],
                history: [],
                loopMode: "off",
                volume: config.defaultVolume,
                paused: false,
                consecutiveFailures: 0,
                alone: false,
                idleTimer: null,
                aloneTimer: null,
                trackEndTimer: null,
                session,
              };
              states.set(request.guildId, state);
              createdState = true;
            }

            const becameCurrent = state.current === null;
            const previousCurrent = state.current;
            const previousUpcoming = [...state.upcoming];
            const previousFailureCount = state.consecutiveFailures;
            const queueTracks = accepted.map((track) => toQueueTrack(track, request.requestedBy));
            const firstTrack = queueTracks[0];
            if (firstTrack === undefined) {
              throw new Error("Resolved track commit unexpectedly contained no tracks");
            }
            if (state.current === null) {
              state.current = queueTracks.shift() ?? null;
              state.consecutiveFailures = 0;
            }
            state.upcoming.push(...queueTracks);
            cancelTimer(state.idleTimer);
            state.idleTimer = null;
            state.alone = false;
            cancelTimer(state.aloneTimer);
            state.aloneTimer = null;

            if (becameCurrent) {
              try {
                await state.session.play(firstTrack.encoded);
                scheduleTrackEndTimer(state);
              } catch (error: unknown) {
                recordPlaybackEvent(request.guildId, "transport-failed");
                dependencies.logger.warn(
                  {
                    event: "initial_track_play_failed",
                    guildId: request.guildId,
                    trackIdentifier: firstTrack.identifier,
                    ...errorFields(error),
                  },
                  "Could not start the initial track",
                );
                if (createdState) {
                  await deleteState(request.guildId, state, "initial-play-failed");
                } else {
                  state.current = previousCurrent;
                  state.upcoming = previousUpcoming;
                  state.consecutiveFailures = previousFailureCount;
                  scheduleIdleTimer(state);
                }
                return { kind: "play-failed" };
              }
            }

            publishPlaybackChange(request.guildId, "queue-updated");

            return {
              kind: "queued",
              addedTrackCount: accepted.length,
              becameCurrent,
              rejectedTrackCount: resolution.rejectedTrackCount,
              truncatedTrackCount: resolution.truncatedTrackCount,
              commitTruncatedTrackCount: resolution.tracks.length - accepted.length,
              playlistName: resolution.playlistName,
              firstTrack: copyQueueTrack(firstTrack),
            };
          });
        });
      } finally {
        coordinator.pendingPlayRequests -= 1;
        discardCoordinatorIfIdle(request.guildId, coordinator);
      }
    },

    setPaused(request, paused) {
      return stateExecutor.run(request.guildId, async () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (state.current === null) {
          return { kind: "ok", value: "no-current" };
        }
        if (state.paused === paused) {
          return { kind: "ok", value: "unchanged" };
        }
        try {
          await state.session.setPaused(paused);
        } catch (error: unknown) {
          recordPlaybackEvent(request.guildId, "transport-failed");
          dependencies.logger.warn(
            {
              event: "player_pause_update_failed",
              guildId: request.guildId,
              paused,
              ...errorFields(error),
            },
            "Could not update player pause state",
          );
          return { kind: "transport-failed" };
        }
        state.paused = paused;
        if (paused) {
          cancelTimer(state.trackEndTimer);
          state.trackEndTimer = null;
        } else {
          scheduleTrackEndTimer(state);
        }
        publishPlaybackChange(request.guildId, "playback-transition");
        return { kind: "ok", value: "updated" };
      });
    },

    setVolume(request, volume) {
      validVolume(volume);
      return stateExecutor.run(request.guildId, async () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (state.volume === volume) {
          return { kind: "ok", value: { volume, changed: false } };
        }
        try {
          await state.session.setVolume(volume);
        } catch (error: unknown) {
          recordPlaybackEvent(request.guildId, "transport-failed");
          dependencies.logger.warn(
            {
              event: "player_volume_update_failed",
              guildId: request.guildId,
              volume,
              ...errorFields(error),
            },
            "Could not update player volume",
          );
          return { kind: "transport-failed" };
        }
        state.volume = volume;
        publishPlaybackChange(request.guildId, "playback-transition");
        return { kind: "ok", value: { volume, changed: true } };
      });
    },

    setLoopMode(request, loopMode) {
      return stateExecutor.run(request.guildId, () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        if (validation.state.loopMode !== loopMode) {
          validation.state.loopMode = loopMode;
          publishPlaybackChange(request.guildId, "playback-transition");
        }
        return { kind: "ok", value: loopMode };
      });
    },

    removeUpcoming(request, displayedIndex) {
      return stateExecutor.run(request.guildId, () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        if (!Number.isSafeInteger(displayedIndex) || displayedIndex < 1) {
          return { kind: "ok", value: null };
        }
        const removed = validation.state.upcoming.splice(displayedIndex - 1, 1)[0];
        if (removed !== undefined) {
          publishPlaybackChange(request.guildId, "queue-updated");
        }
        return { kind: "ok", value: removed === undefined ? null : copyQueueTrack(removed) };
      });
    },

    moveUpcoming(request, fromIndex, toIndex) {
      return stateExecutor.run(request.guildId, () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const upcoming = validation.state.upcoming;
        if (
          !Number.isSafeInteger(fromIndex) ||
          !Number.isSafeInteger(toIndex) ||
          fromIndex < 1 ||
          toIndex < 1 ||
          fromIndex > upcoming.length ||
          toIndex > upcoming.length
        ) {
          return { kind: "ok", value: null };
        }
        const track = upcoming[fromIndex - 1];
        if (track === undefined) {
          return { kind: "ok", value: null };
        }
        if (fromIndex === toIndex) {
          return {
            kind: "ok",
            value: { track: copyQueueTrack(track), changed: false },
          };
        }
        upcoming.splice(fromIndex - 1, 1);
        upcoming.splice(toIndex - 1, 0, track);
        publishPlaybackChange(request.guildId, "queue-updated");
        return {
          kind: "ok",
          value: { track: copyQueueTrack(track), changed: true },
        };
      });
    },

    clearUpcoming(request) {
      return stateExecutor.run(request.guildId, () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        const removed = state.upcoming.length;
        state.upcoming = [];
        if (state.current === null) {
          scheduleIdleTimer(state);
        }
        if (removed > 0) {
          publishPlaybackChange(request.guildId, "queue-updated");
        }
        return { kind: "ok", value: removed };
      });
    },

    shuffleUpcoming(request) {
      return stateExecutor.run(request.guildId, () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (state.upcoming.length < 2) {
          return { kind: "ok", value: false };
        }

        const shuffled = [...state.upcoming];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const sample = random();
          if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
            throw new RangeError(
              "random must return a finite number from 0 up to, but not including, 1",
            );
          }
          const swapIndex = Math.floor(sample * (index + 1));
          const current = shuffled[index];
          const replacement = shuffled[swapIndex];
          if (current !== undefined && replacement !== undefined) {
            shuffled[index] = replacement;
            shuffled[swapIndex] = current;
          }
        }
        state.upcoming = shuffled;
        publishPlaybackChange(request.guildId, "queue-updated");
        return { kind: "ok", value: true };
      });
    },

    jump(request, displayedIndex) {
      const captured = states.get(request.guildId);
      const current = captured?.current;

      return stateExecutor.run(request.guildId, async () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (current === undefined || current === null || state.current !== current) {
          return { kind: "ok", value: null };
        }
        if (
          !Number.isSafeInteger(displayedIndex) ||
          displayedIndex < 1 ||
          displayedIndex > state.upcoming.length
        ) {
          return { kind: "ok", value: null };
        }
        const [target] = state.upcoming.splice(displayedIndex - 1, 1);
        if (target === undefined) {
          return { kind: "ok", value: null };
        }
        state.upcoming.unshift(target);
        await stopPlaybackBestEffort(state);
        const result = transitionCurrent(state, "manual-skip");
        return { kind: "ok", value: await applyPlaybackEffect(state, result) };
      });
    },

    previous(request) {
      const captured = states.get(request.guildId);
      const current = captured?.current;

      return stateExecutor.run(request.guildId, async () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (current === undefined || current === null || state.current !== current) {
          return { kind: "ok", value: null };
        }
        const prior = state.history.pop();
        if (prior === undefined) {
          return { kind: "ok", value: null };
        }

        await stopPlaybackBestEffort(state);
        if (state.loopMode === "queue") {
          const loopedIndex = state.upcoming.findLastIndex(
            (track) =>
              track.encoded === prior.encoded && track.requestedBy.id === prior.requestedBy.id,
          );
          if (loopedIndex >= 0) {
            state.upcoming.splice(loopedIndex, 1);
          }
        }
        state.upcoming.unshift(current);
        setCurrentAfterTransition(state, prior);
        const result = await applyPlaybackEffect(state, {
          kind: "advanced",
          current: copyQueueTrack(prior),
        });
        return {
          kind: "ok",
          value:
            result.kind === "advanced" || result.kind === "replayed"
              ? result.current === null
                ? null
                : copyQueueTrack(result.current)
              : null,
        };
      });
    },

    skip(request) {
      const captured = states.get(request.guildId);
      const current = captured?.current;

      return stateExecutor.run(request.guildId, async () => {
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        if (current === undefined || current === null || state.current !== current) {
          return {
            kind: "ok",
            value: {
              kind: "ignored",
              reason: current === undefined || current === null ? "no-current" : "stale-track",
            },
          };
        }
        await stopPlaybackBestEffort(state);
        const result = transitionCurrent(state, "manual-skip");
        return { kind: "ok", value: await applyPlaybackEffect(state, result) };
      });
    },

    stop(request) {
      return stateExecutor.run(request.guildId, async () => {
        const missingState = states.get(request.guildId) === undefined;
        if (missingState) {
          if (!request.validateCommit()) {
            return { kind: "rejected", reason: "voice-changed" };
          }
          const coordinator = invalidate(request.guildId);
          discardCoordinatorIfIdle(request.guildId, coordinator);
          return { kind: "ok", value: "unchanged" };
        }
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        const state = validation.state;
        const changed = state.current !== null || state.upcoming.length > 0;
        const coordinator = invalidate(request.guildId);
        if (changed) {
          await stopPlaybackBestEffort(state);
        }
        state.current = null;
        state.upcoming = [];
        state.history = [];
        state.paused = false;
        state.consecutiveFailures = 0;
        scheduleIdleTimer(state);
        discardCoordinatorIfIdle(request.guildId, coordinator);
        if (changed) {
          publishPlaybackChange(request.guildId, "playback-transition");
        }
        return { kind: "ok", value: changed ? "stopped" : "unchanged" };
      });
    },

    leave(request) {
      return stateExecutor.run(request.guildId, async () => {
        const missingState = states.get(request.guildId) === undefined;
        if (missingState) {
          if (!request.validateCommit()) {
            return { kind: "rejected", reason: "voice-changed" };
          }
          const coordinator = invalidate(request.guildId);
          discardCoordinatorIfIdle(request.guildId, coordinator);
          return { kind: "ok", value: false };
        }
        const validation = validateControl(request);
        if ("result" in validation) {
          return validation.result;
        }
        await deleteState(request.guildId, validation.state, "leave");
        return { kind: "ok", value: true };
      });
    },

    cleanupUnexpected(guildId) {
      return stateExecutor.run(guildId, async () => {
        const state = states.get(guildId);
        if (state === undefined) {
          const coordinator = invalidate(guildId);
          discardCoordinatorIfIdle(guildId, coordinator);
          return false;
        }
        return await deleteState(guildId, state, "unexpected-voice-change");
      });
    },

    async handleLavalinkInvalidation(reason) {
      const cleanupReason: CleanupReason =
        reason === "session-lost" ? "lavalink-session-lost" : "lavalink-unavailable";
      const guildIds = new Set([...states.keys(), ...coordinators.keys()]);
      const results = await Promise.all(
        [...guildIds].map((guildId) =>
          stateExecutor.run(guildId, async () => {
            const state = states.get(guildId);
            if (state !== undefined) {
              return await deleteState(guildId, state, cleanupReason);
            }
            const coordinator = invalidate(guildId);
            discardCoordinatorIfIdle(guildId, coordinator);
            return false;
          }),
        ),
      );
      return results.filter(Boolean).length;
    },

    handleTrackEnd(event) {
      return handleTrackEndInternal(event);
    },

    handleTrackException(event) {
      return handleTrackExceptionInternal(event);
    },

    handleTrackStuck(event) {
      return handleTrackStuckInternal(event);
    },

    updateAloneStatus(guildId, playerToken, alone) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined || state.playerToken !== playerToken) {
          return false;
        }
        state.alone = alone;
        if (alone) {
          scheduleAloneTimer(state);
        } else {
          cancelTimer(state.aloneTimer);
          state.aloneTimer = null;
        }
        return true;
      });
    },

    async stopService() {
      acceptingPlayRequests = false;
      const guildIds = new Set([...states.keys(), ...coordinators.keys()]);
      await Promise.all(
        [...guildIds].map((guildId) =>
          stateExecutor.run(guildId, async () => {
            const state = states.get(guildId);
            if (state !== undefined) {
              await deleteState(guildId, state, "shutdown");
              return;
            }
            const coordinator = invalidate(guildId);
            discardCoordinatorIfIdle(guildId, coordinator);
          }),
        ),
      );
      playbackChangeListeners.clear();
    },
  };
}
