import type { Logger } from "pino";
import { type LavalinkResponse, type Track as LavalinkTrack, LoadType } from "shoukaku";

import type { Config } from "../config.js";
import { errorFields } from "../utils.js";
import { classifyPlayInput } from "./urls.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;

export interface ResolverRest {
  resolve(identifier: string): Promise<LavalinkResponse | undefined>;
}

export interface ResolverNode {
  readonly rest: ResolverRest;
}

export interface ReadyNodeProvider {
  getReadyNode(): ResolverNode | undefined;
}

export interface ResolvedTrack {
  readonly encoded: string;
  readonly identifier: string;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly isStream: boolean;
  readonly uri: string | null;
  readonly sourceName: string;
}

export type ResolutionSource = "direct" | "youtube-music-search" | "youtube-search";

export type ResolveResult =
  | {
      readonly kind: "tracks";
      readonly source: ResolutionSource;
      readonly tracks: readonly ResolvedTrack[];
      readonly playlistName: string | null;
      readonly rejectedTrackCount: number;
      readonly truncatedTrackCount: number;
    }
  | {
      readonly kind: "no-match";
      readonly reason: "empty" | "no-suitable-tracks";
    }
  | {
      readonly kind: "failure";
      readonly reason: "invalid-response" | "load-failed" | "request-failed";
    }
  | { readonly kind: "capacity-exhausted" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unsupported-url" };

export interface TrackResolver {
  resolve(input: string, availableCapacity: number): Promise<ResolveResult>;
}

type ResolverConfig = Pick<
  Config["playback"],
  "allowLivestreams" | "maxPlaylistTracks" | "maxQueueTracks" | "maxTrackDurationHours"
>;

type ResolutionMode = "playlist" | "single";

interface ResolverLimits {
  readonly allowLivestreams: boolean;
  readonly maxPlaylistTracks: number;
  readonly maxQueueTracks: number;
  readonly maxTrackDurationMs: number;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function createLimits(config: ResolverConfig): ResolverLimits {
  positiveSafeInteger(config.maxPlaylistTracks, "maxPlaylistTracks");
  positiveSafeInteger(config.maxQueueTracks, "maxQueueTracks");
  positiveSafeInteger(config.maxTrackDurationHours, "maxTrackDurationHours");

  const maxTrackDurationMs = config.maxTrackDurationHours * MILLISECONDS_PER_HOUR;
  if (!Number.isSafeInteger(maxTrackDurationMs)) {
    throw new RangeError("maxTrackDurationHours is too large to convert safely");
  }

  return {
    allowLivestreams: config.allowLivestreams,
    maxPlaylistTracks: config.maxPlaylistTracks,
    maxQueueTracks: config.maxQueueTracks,
    maxTrackDurationMs,
  };
}

function normalizeTrack(track: LavalinkTrack): ResolvedTrack {
  return {
    encoded: track.encoded,
    identifier: track.info.identifier,
    title: track.info.title,
    author: track.info.author,
    durationMs: track.info.length,
    isStream: track.info.isStream,
    uri: track.info.uri ?? null,
    sourceName: track.info.sourceName,
  };
}

function isSuitableTrack(track: LavalinkTrack, limits: ResolverLimits): boolean {
  return (
    track.encoded.trim().length > 0 &&
    Number.isSafeInteger(track.info.length) &&
    track.info.length >= 0 &&
    track.info.length <= limits.maxTrackDurationMs &&
    (limits.allowLivestreams || !track.info.isStream)
  );
}

function normalizeTracks(
  candidates: readonly LavalinkTrack[],
  limit: number,
  limits: ResolverLimits,
  mode: ResolutionMode,
): Pick<
  Extract<ResolveResult, { kind: "tracks" }>,
  "rejectedTrackCount" | "tracks" | "truncatedTrackCount"
> {
  const tracks: ResolvedTrack[] = [];
  let rejectedTrackCount = 0;
  let suitableTrackCount = 0;

  for (const candidate of candidates) {
    if (!isSuitableTrack(candidate, limits)) {
      rejectedTrackCount += 1;
      continue;
    }

    suitableTrackCount += 1;
    if (tracks.length < limit) {
      tracks.push(normalizeTrack(candidate));
    }

    if (mode === "single") {
      break;
    }
  }

  return {
    tracks,
    rejectedTrackCount,
    truncatedTrackCount: mode === "playlist" ? suitableTrackCount - tracks.length : 0,
  };
}

function responseTracks(response: LavalinkResponse): readonly LavalinkTrack[] {
  switch (response.loadType) {
    case LoadType.TRACK:
      return [response.data];
    case LoadType.PLAYLIST:
      return response.data.tracks;
    case LoadType.SEARCH:
      return response.data;
    case LoadType.EMPTY:
    case LoadType.ERROR:
      return [];
  }
}

function normalizeResponse(
  response: LavalinkResponse,
  source: ResolutionSource,
  mode: ResolutionMode,
  availableCapacity: number,
  limits: ResolverLimits,
  logger: Logger,
): ResolveResult {
  if (response.loadType === LoadType.ERROR) {
    logger.warn(
      {
        event: "resolver_load_failed",
        resolutionSource: source,
        severity: response.data.severity,
      },
      "Lavalink failed to load a media identifier",
    );
    return { kind: "failure", reason: "load-failed" };
  }

  if (response.loadType === LoadType.EMPTY) {
    return { kind: "no-match", reason: "empty" };
  }

  const resultLimit =
    mode === "playlist"
      ? Math.min(availableCapacity, limits.maxPlaylistTracks)
      : Math.min(availableCapacity, 1);
  const normalized = normalizeTracks(responseTracks(response), resultLimit, limits, mode);

  if (normalized.tracks.length === 0) {
    return { kind: "no-match", reason: "no-suitable-tracks" };
  }

  return {
    kind: "tracks",
    source,
    tracks: normalized.tracks,
    playlistName: response.loadType === LoadType.PLAYLIST ? response.data.info.name : null,
    rejectedTrackCount: normalized.rejectedTrackCount,
    truncatedTrackCount: normalized.truncatedTrackCount,
  };
}

async function resolveIdentifier(
  rest: ResolverRest,
  identifier: string,
  source: ResolutionSource,
  mode: ResolutionMode,
  availableCapacity: number,
  limits: ResolverLimits,
  logger: Logger,
): Promise<ResolveResult> {
  try {
    const response = await rest.resolve(identifier);
    if (response === undefined) {
      logger.warn(
        { event: "resolver_invalid_response", resolutionSource: source },
        "Lavalink returned no load result",
      );
      return { kind: "failure", reason: "invalid-response" };
    }

    return normalizeResponse(response, source, mode, availableCapacity, limits, logger);
  } catch (error: unknown) {
    logger.error(
      {
        event: "resolver_request_failed",
        resolutionSource: source,
        ...errorFields(error),
      },
      "Lavalink load request failed",
    );
    return { kind: "failure", reason: "request-failed" };
  }
}

export function createTrackResolver(
  nodeProvider: ReadyNodeProvider,
  config: ResolverConfig,
  logger: Logger,
): TrackResolver {
  const limits = createLimits(config);

  return {
    async resolve(input: string, availableCapacity: number): Promise<ResolveResult> {
      if (
        !Number.isSafeInteger(availableCapacity) ||
        availableCapacity < 0 ||
        availableCapacity > limits.maxQueueTracks
      ) {
        throw new RangeError(`availableCapacity must be between 0 and ${limits.maxQueueTracks}`);
      }

      const playInput = classifyPlayInput(input);
      if (playInput.kind === "unsupported-url") {
        return { kind: "unsupported-url" };
      }

      if (playInput.kind === "search" && playInput.query.length === 0) {
        return { kind: "no-match", reason: "empty" };
      }

      if (availableCapacity === 0) {
        return { kind: "capacity-exhausted" };
      }

      const node = nodeProvider.getReadyNode();
      if (node === undefined) {
        return { kind: "unavailable" };
      }

      if (playInput.kind === "youtube-url") {
        return resolveIdentifier(
          node.rest,
          playInput.url,
          "direct",
          playInput.mediaType === "playlist" ? "playlist" : "single",
          availableCapacity,
          limits,
          logger,
        );
      }

      const musicResult = await resolveIdentifier(
        node.rest,
        `ytmsearch:${playInput.query}`,
        "youtube-music-search",
        "single",
        availableCapacity,
        limits,
        logger,
      );
      if (musicResult.kind !== "no-match") {
        return musicResult;
      }

      return resolveIdentifier(
        node.rest,
        `ytsearch:${playInput.query}`,
        "youtube-search",
        "single",
        availableCapacity,
        limits,
        logger,
      );
    },
  };
}
