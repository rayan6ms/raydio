import { randomUUID } from "node:crypto";

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import type { GuildPlaybackSnapshot, QueueTrack } from "./music/state.js";
import { escapeExternalText, truncateMessage } from "./utils.js";

const QUEUE_VIEW_LIMIT = 10;
const MAX_QUEUE_VIEW_SESSIONS = 1_000;
const QUEUE_CUSTOM_ID_PREFIX = "raydio:queue:";
const QUEUE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

export interface QueuePageView {
  readonly content: string;
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly page: number;
  readonly pageCount: number;
}

export type QueueInteractionResolution =
  | { readonly kind: "unrelated" }
  | { readonly kind: "stale" }
  | { readonly kind: "ready"; readonly view: QueuePageView };

export interface QueueViewController {
  render(snapshot: GuildPlaybackSnapshot | undefined, requestedPage?: number): QueuePageView;
  resolve(
    guildId: string,
    customId: string,
    snapshot: GuildPlaybackSnapshot | undefined,
  ): QueueInteractionResolution;
}

export function isQueueViewCustomId(customId: string): boolean {
  return customId.startsWith(QUEUE_CUSTOM_ID_PREFIX);
}

function safeSegment(value: string, maximumLength: number): string {
  return truncateMessage(escapeExternalText(value).replaceAll(/\s+/g, " "), maximumLength);
}

export function formatDuration(durationMs: number, isStream = false): string {
  if (isStream) {
    return "LIVE";
  }
  const totalSeconds = Number.isFinite(durationMs)
    ? Math.max(0, Math.floor(durationMs / 1_000))
    : 0;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function compactTrack(track: QueueTrack): string {
  const title = safeSegment(track.title, 60);
  const author = safeSegment(track.author, 30);
  const requester = safeSegment(track.requestedBy.label, 24);
  return `**${title}** — ${author} [${formatDuration(track.durationMs, track.isStream)}] • ${requester}`;
}

function finiteQueueDuration(snapshot: GuildPlaybackSnapshot): {
  readonly durationMs: number;
  readonly streamCount: number;
} {
  let durationMs = 0;
  let streamCount = 0;

  if (snapshot.current !== null) {
    if (snapshot.current.isStream) {
      streamCount += 1;
    } else {
      durationMs += Math.max(0, snapshot.current.durationMs - snapshot.positionMs);
    }
  }
  for (const track of snapshot.upcoming) {
    if (track.isStream) {
      streamCount += 1;
    } else {
      durationMs += track.durationMs;
    }
  }
  return { durationMs, streamCount };
}

export function formatQueueSnapshot(
  snapshot: GuildPlaybackSnapshot | undefined,
  requestedPage = 0,
): string {
  if (snapshot?.current === null || snapshot === undefined) {
    return "The queue is empty.";
  }

  const pageCount = Math.max(1, Math.ceil(snapshot.upcoming.length / QUEUE_VIEW_LIMIT));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.min(Math.max(0, requestedPage), pageCount - 1)
    : 0;
  const startIndex = page * QUEUE_VIEW_LIMIT;
  const visible = snapshot.upcoming.slice(startIndex, startIndex + QUEUE_VIEW_LIMIT);
  const currentProgress = snapshot.current.isStream
    ? "LIVE"
    : `${formatDuration(Math.min(snapshot.positionMs, snapshot.current.durationMs))} elapsed • ${formatDuration(
        Math.max(0, snapshot.current.durationMs - snapshot.positionMs),
      )} remaining`;
  const total = finiteQueueDuration(snapshot);
  const streamNote = total.streamCount === 0 ? "" : ` • ${total.streamCount} live not included`;
  const lines = [`Now playing: ${compactTrack(snapshot.current)}`, `Progress: ${currentProgress}`];
  if (visible.length === 0) {
    lines.push("Upcoming: empty");
  } else {
    lines.push(
      `Upcoming • Page ${page + 1}/${pageCount}:`,
      ...visible.map((track, index) => `${startIndex + index + 1}. ${compactTrack(track)}`),
    );
  }
  lines.push(
    `Finite queue time remaining: ${formatDuration(total.durationMs)}${streamNote}`,
    `Status: ${snapshot.paused ? "paused" : "playing"} • Loop: ${snapshot.loopMode} • Volume: ${snapshot.volume}%`,
  );
  return truncateMessage(lines.join("\n"));
}

function queueButton(
  sessionId: string,
  page: number,
  label: string,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${QUEUE_CUSTOM_ID_PREFIX}${sessionId}:${page}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

export function createQueueViewController(
  createSessionId: () => string = randomUUID,
): QueueViewController {
  const sessions = new Map<
    string,
    { readonly id: string; readonly playerToken: GuildPlaybackSnapshot["playerToken"] }
  >();

  function sessionFor(snapshot: GuildPlaybackSnapshot): string {
    const existing = sessions.get(snapshot.guildId);
    if (existing?.playerToken === snapshot.playerToken) {
      sessions.delete(snapshot.guildId);
      sessions.set(snapshot.guildId, existing);
      return existing.id;
    }
    const id = createSessionId();
    if (!QUEUE_SESSION_ID_PATTERN.test(id)) {
      throw new Error("Queue view session ID must contain 1-48 URL-safe characters");
    }
    if (!sessions.has(snapshot.guildId) && sessions.size >= MAX_QUEUE_VIEW_SESSIONS) {
      const oldestGuildId = sessions.keys().next().value;
      if (oldestGuildId !== undefined) {
        sessions.delete(oldestGuildId);
      }
    }
    sessions.set(snapshot.guildId, { id, playerToken: snapshot.playerToken });
    return id;
  }

  function render(snapshot: GuildPlaybackSnapshot | undefined, requestedPage = 0): QueuePageView {
    if (snapshot?.current === null || snapshot === undefined) {
      if (snapshot !== undefined) {
        sessions.delete(snapshot.guildId);
      }
      return { content: "The queue is empty.", components: [], page: 0, pageCount: 1 };
    }

    const pageCount = Math.max(1, Math.ceil(snapshot.upcoming.length / QUEUE_VIEW_LIMIT));
    const page = Number.isSafeInteger(requestedPage)
      ? Math.min(Math.max(0, requestedPage), pageCount - 1)
      : 0;
    if (pageCount === 1) {
      sessionFor(snapshot);
      return { content: formatQueueSnapshot(snapshot, page), components: [], page, pageCount };
    }

    const sessionId = sessionFor(snapshot);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      queueButton(sessionId, Math.max(0, page - 1), "Previous", page === 0),
      queueButton(sessionId, Math.min(pageCount - 1, page + 1), "Next", page === pageCount - 1),
    );
    return { content: formatQueueSnapshot(snapshot, page), components: [row], page, pageCount };
  }

  return {
    render,
    resolve(guildId, customId, snapshot) {
      if (!isQueueViewCustomId(customId)) {
        return { kind: "unrelated" };
      }
      const match = /^raydio:queue:([A-Za-z0-9_-]{1,48}):(\d+)$/.exec(customId);
      if (match?.[1] === undefined || match[2] === undefined) {
        return { kind: "stale" };
      }
      const requestedPage = Number(match[2]);
      const session = sessions.get(guildId);
      if (
        session?.id === match[1] &&
        (snapshot?.current === null ||
          snapshot === undefined ||
          session.playerToken !== snapshot.playerToken)
      ) {
        sessions.delete(guildId);
        return { kind: "stale" };
      }
      if (
        snapshot?.current === null ||
        snapshot === undefined ||
        session === undefined ||
        session.id !== match[1] ||
        session.playerToken !== snapshot.playerToken ||
        !Number.isSafeInteger(requestedPage)
      ) {
        return { kind: "stale" };
      }
      return { kind: "ready", view: render(snapshot, requestedPage) };
    },
  };
}
