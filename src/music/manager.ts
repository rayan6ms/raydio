import type { Logger } from "pino";

import type { Config } from "../config.js";
import type { ResolveResult, TrackResolver } from "./resolver.js";
import { KeyedSerialExecutor } from "./serial.js";
import {
  copyQueueTrack,
  type GuildPlaybackSnapshot,
  type LoopMode,
  type PlayerToken,
  type QueueTrack,
  type TrackRequester,
  toQueueTrack,
} from "./state.js";

const MILLISECONDS_PER_SECOND = 1_000;
const FAILURE_LIMIT = 3;

export type TrackEndReason = "finished" | "loadFailed" | "stopped" | "replaced" | "cleanup";

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
  readonly input: string;
  readonly requestedBy: TrackRequester;
  readonly getRequesterVoiceChannelId: () => string | null;
}

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
    }
  | { readonly kind: "not-queued"; readonly resolution: UnqueuedResolution }
  | { readonly kind: "pending-limit" }
  | { readonly kind: "stale" }
  | { readonly kind: "voice-changed" }
  | { readonly kind: "wrong-channel" }
  | { readonly kind: "queue-full" };

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
  getSnapshot(guildId: string): GuildPlaybackSnapshot | undefined;
  getPendingPlayRequestCount(guildId: string): number;
  requestPlay(request: PlayRequest): Promise<PlayRequestResult>;
  setLoopMode(guildId: string, loopMode: LoopMode): Promise<boolean>;
  removeUpcoming(guildId: string, displayedIndex: number): Promise<QueueTrack | undefined>;
  clearUpcoming(guildId: string): Promise<number>;
  shuffleUpcoming(guildId: string): Promise<boolean>;
  skip(guildId: string): Promise<TransitionResult>;
  stop(guildId: string): Promise<boolean>;
  leave(guildId: string): Promise<boolean>;
  cleanupUnexpected(guildId: string): Promise<boolean>;
  handleTrackEnd(
    event: PlayerEventIdentity & { readonly reason: TrackEndReason },
  ): Promise<TransitionResult>;
  handleTrackException(event: PlayerEventIdentity): Promise<TransitionResult>;
  handleTrackStuck(event: PlayerEventIdentity): Promise<TransitionResult>;
  updateAloneStatus(guildId: string, playerToken: PlayerToken, alone: boolean): Promise<boolean>;
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
  loopMode: LoopMode;
  volume: number;
  paused: boolean;
  consecutiveFailures: number;
  alone: boolean;
  idleTimer: TimerHandle | null;
  aloneTimer: TimerHandle | null;
}

interface MusicManagerDependencies {
  readonly resolver: TrackResolver;
  readonly logger: Logger;
  readonly scheduler?: TimerScheduler;
  readonly random?: () => number;
  readonly createPlayerToken?: () => PlayerToken;
}

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

function validVolume(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new RangeError("defaultVolume must be a safe integer between 0 and 100");
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
    loopMode: state.loopMode,
    volume: state.volume,
    paused: state.paused,
    consecutiveFailures: state.consecutiveFailures,
    alone: state.alone,
  };
}

function queueSize(state: GuildPlaybackState | undefined): number {
  if (state === undefined) {
    return 0;
  }
  return state.upcoming.length + (state.current === null ? 0 : 1);
}

export function createMusicManager(
  config: ManagerConfig,
  dependencies: MusicManagerDependencies,
): MusicManager {
  positiveSafeInteger(config.maxQueueTracks, "maxQueueTracks");
  positiveSafeInteger(config.maxPendingPlayRequests, "maxPendingPlayRequests");
  validVolume(config.defaultVolume);
  const idleDelayMs = durationMs(config.idleDisconnectSeconds, "idleDisconnectSeconds");
  const aloneDelayMs = durationMs(config.aloneDisconnectSeconds, "aloneDisconnectSeconds");

  const states = new Map<string, GuildPlaybackState>();
  const coordinators = new Map<string, GuildCoordinator>();
  const stateExecutor = new KeyedSerialExecutor<string>();
  const playExecutor = new KeyedSerialExecutor<string>();
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const random = dependencies.random ?? Math.random;
  const createPlayerToken = dependencies.createPlayerToken ?? (() => Symbol("player"));

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
    state.idleTimer = null;
    state.aloneTimer = null;
  }

  function invalidate(guildId: string): GuildCoordinator {
    const coordinator = coordinatorFor(guildId);
    coordinator.epoch += 1;
    return coordinator;
  }

  function deleteState(guildId: string, state: GuildPlaybackState): boolean {
    if (states.get(guildId) !== state) {
      return false;
    }

    const coordinator = invalidate(guildId);
    cancelStateTimers(state);
    states.delete(guildId);
    discardCoordinatorIfIdle(guildId, coordinator);
    return true;
  }

  function scheduleIdleTimer(state: GuildPlaybackState): void {
    if (state.current !== null || state.upcoming.length > 0 || state.idleTimer !== null) {
      return;
    }

    let handle: TimerHandle;
    handle = scheduler.setTimeout(() => {
      void stateExecutor
        .run(state.guildId, () => {
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
          deleteState(state.guildId, active);
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
        .run(state.guildId, () => {
          const active = states.get(state.guildId);
          if (active !== state || active.aloneTimer !== handle || !active.alone) {
            return;
          }

          active.aloneTimer = null;
          deleteState(state.guildId, active);
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

  function setCurrentAfterTransition(state: GuildPlaybackState, next: QueueTrack | null): void {
    state.current = next;
    state.paused = false;
    if (next === null) {
      scheduleIdleTimer(state);
    } else {
      cancelTimer(state.idleTimer);
      state.idleTimer = null;
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

  return {
    getSnapshot(guildId) {
      const state = states.get(guildId);
      return state === undefined ? undefined : copySnapshot(state);
    },

    getPendingPlayRequestCount(guildId) {
      return coordinators.get(guildId)?.pendingPlayRequests ?? 0;
    },

    async requestPlay(request) {
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

          return stateExecutor.run(request.guildId, (): PlayRequestResult => {
            if (coordinator.epoch !== capturedEpoch) {
              return { kind: "stale" };
            }
            if (request.getRequesterVoiceChannelId() !== request.intendedVoiceChannelId) {
              return { kind: "voice-changed" };
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

            if (state === undefined) {
              state = {
                guildId: request.guildId,
                voiceChannelId: request.intendedVoiceChannelId,
                notificationChannelId: request.notificationChannelId,
                playerToken: createPlayerToken(),
                current: null,
                upcoming: [],
                loopMode: "off",
                volume: config.defaultVolume,
                paused: false,
                consecutiveFailures: 0,
                alone: false,
                idleTimer: null,
                aloneTimer: null,
              };
              states.set(request.guildId, state);
            }

            const becameCurrent = state.current === null;
            const queueTracks = accepted.map((track) => toQueueTrack(track, request.requestedBy));
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

            return {
              kind: "queued",
              addedTrackCount: accepted.length,
              becameCurrent,
              rejectedTrackCount: resolution.rejectedTrackCount,
              truncatedTrackCount: resolution.truncatedTrackCount,
              commitTruncatedTrackCount: resolution.tracks.length - accepted.length,
              playlistName: resolution.playlistName,
            };
          });
        });
      } finally {
        coordinator.pendingPlayRequests -= 1;
        discardCoordinatorIfIdle(request.guildId, coordinator);
      }
    },

    setLoopMode(guildId, loopMode) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          return false;
        }
        state.loopMode = loopMode;
        return true;
      });
    },

    removeUpcoming(guildId, displayedIndex) {
      if (!Number.isSafeInteger(displayedIndex) || displayedIndex < 1) {
        return Promise.resolve(undefined);
      }
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          return undefined;
        }
        const removed = state.upcoming.splice(displayedIndex - 1, 1)[0];
        return removed === undefined ? undefined : copyQueueTrack(removed);
      });
    },

    clearUpcoming(guildId) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          return 0;
        }
        const removed = state.upcoming.length;
        state.upcoming = [];
        if (state.current === null) {
          scheduleIdleTimer(state);
        }
        return removed;
      });
    },

    shuffleUpcoming(guildId) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined || state.upcoming.length < 2) {
          return false;
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
        return true;
      });
    },

    skip(guildId) {
      const captured = states.get(guildId);
      const playerToken = captured?.playerToken;
      const current = captured?.current;

      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          return { kind: "ignored", reason: "no-state" };
        }
        if (state.playerToken !== playerToken) {
          return { kind: "ignored", reason: "stale-session" };
        }
        if (current === undefined || current === null || state.current !== current) {
          return {
            kind: "ignored",
            reason: current === undefined || current === null ? "no-current" : "stale-track",
          };
        }
        return transitionCurrent(state, "manual-skip");
      });
    },

    stop(guildId) {
      return stateExecutor.run(guildId, () => {
        const coordinator = invalidate(guildId);
        const state = states.get(guildId);
        if (state === undefined) {
          discardCoordinatorIfIdle(guildId, coordinator);
          return false;
        }
        state.current = null;
        state.upcoming = [];
        state.paused = false;
        state.consecutiveFailures = 0;
        scheduleIdleTimer(state);
        return true;
      });
    },

    leave(guildId) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          const coordinator = invalidate(guildId);
          discardCoordinatorIfIdle(guildId, coordinator);
          return false;
        }
        return deleteState(guildId, state);
      });
    },

    cleanupUnexpected(guildId) {
      return stateExecutor.run(guildId, () => {
        const state = states.get(guildId);
        if (state === undefined) {
          const coordinator = invalidate(guildId);
          discardCoordinatorIfIdle(guildId, coordinator);
          return false;
        }
        return deleteState(guildId, state);
      });
    },

    handleTrackEnd(event) {
      const capturedState = states.get(event.guildId);
      const capturedCurrent = capturedState?.current;
      return stateExecutor.run(event.guildId, () => {
        if (
          event.reason === "stopped" ||
          event.reason === "replaced" ||
          event.reason === "cleanup"
        ) {
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
        return transitionCurrent(
          validation.state,
          event.reason === "finished" ? "finished" : "failure",
        );
      });
    },

    handleTrackException(event) {
      const capturedState = states.get(event.guildId);
      const capturedCurrent = capturedState?.current;
      return stateExecutor.run(event.guildId, () => {
        const validation = validateEvent(event, capturedState, capturedCurrent);
        if ("result" in validation) {
          return validation.result;
        }
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
    },

    handleTrackStuck(event) {
      const capturedState = states.get(event.guildId);
      const capturedCurrent = capturedState?.current;
      return stateExecutor.run(event.guildId, () => {
        const validation = validateEvent(event, capturedState, capturedCurrent);
        if ("result" in validation) {
          return validation.result;
        }
        dependencies.logger.warn(
          {
            event: "track_stuck",
            guildId: event.guildId,
            trackIdentifier: validation.state.current?.identifier,
          },
          "Player reported a stuck track",
        );
        return transitionCurrent(validation.state, "failure");
      });
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
  };
}
