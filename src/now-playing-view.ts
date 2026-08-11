import { randomUUID } from "node:crypto";

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import type { GuildPlaybackSnapshot } from "./music/state.js";
import { formatDuration } from "./queue-view.js";
import { escapeExternalText, truncateMessage } from "./utils.js";

const NOW_PLAYING_CUSTOM_ID_PREFIX = "raydio:player:";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const SESSION_LIMIT = 1_000;
const PLAYER_COLOR = 0x8b5cf6;
const PROGRESS_SEGMENTS = 30;

export type PlayerControlAction =
  | "leave"
  | "loop"
  | "pause"
  | "previous"
  | "queue"
  | "skip"
  | "stop";

export interface NowPlayingView {
  readonly content: string | null;
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
}

export type PlayerControlResolution =
  | { readonly kind: "unrelated" }
  | { readonly kind: "stale" }
  | { readonly kind: "ready"; readonly action: PlayerControlAction };

export interface NowPlayingViewController {
  render(snapshot: GuildPlaybackSnapshot | undefined): NowPlayingView;
  resolve(
    guildId: string,
    customId: string,
    snapshot: GuildPlaybackSnapshot | undefined,
  ): PlayerControlResolution;
  retire(guildId: string): void;
}

export function isNowPlayingCustomId(customId: string): boolean {
  return customId.startsWith(NOW_PLAYING_CUSTOM_ID_PREFIX);
}

function safeSegment(value: string, maximumLength: number): string {
  return truncateMessage(escapeExternalText(value).replaceAll(/\s+/g, " "), maximumLength);
}

function sourceUrl(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    const url = new URL(uri);
    return url.protocol === "https:" &&
      ["music.youtube.com", "www.youtube.com", "youtube.com", "youtu.be"].includes(
        url.hostname.toLowerCase(),
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function thumbnailUrl(identifier: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(identifier)
    ? `https://i.ytimg.com/vi/${identifier}/hqdefault.jpg`
    : null;
}

function progressBar(positionMs: number, durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "●━━━━━━━━━━━━━━━";
  }
  const ratio = Math.max(0, Math.min(1, positionMs / durationMs));
  const marker = Math.min(PROGRESS_SEGMENTS - 1, Math.floor(ratio * PROGRESS_SEGMENTS));
  return Array.from({ length: PROGRESS_SEGMENTS }, (_, index) =>
    index === marker ? "●" : "━",
  ).join("");
}

function button(
  sessionId: string,
  action: PlayerControlAction,
  label: string,
  emoji: string,
  style: ButtonStyle,
  disabled = false,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${NOW_PLAYING_CUSTOM_ID_PREFIX}${sessionId}:${action}`)
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(disabled);
}

function loopLabel(mode: GuildPlaybackSnapshot["loopMode"]): string {
  return mode === "off" ? "Loop Off" : mode === "track" ? "Loop Song" : "Loop Queue";
}

export function createNowPlayingViewController(
  createSessionId: () => string = randomUUID,
): NowPlayingViewController {
  const sessions = new Map<
    string,
    { readonly id: string; readonly playerToken: GuildPlaybackSnapshot["playerToken"] }
  >();

  function sessionFor(snapshot: GuildPlaybackSnapshot): string {
    const existing = sessions.get(snapshot.guildId);
    if (existing?.playerToken === snapshot.playerToken) {
      return existing.id;
    }
    const id = createSessionId();
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error("Now Playing session ID must contain 1-48 URL-safe characters");
    }
    if (!sessions.has(snapshot.guildId) && sessions.size >= SESSION_LIMIT) {
      const oldestGuild = sessions.keys().next().value;
      if (oldestGuild !== undefined) {
        sessions.delete(oldestGuild);
      }
    }
    sessions.set(snapshot.guildId, { id, playerToken: snapshot.playerToken });
    return id;
  }

  return {
    render(snapshot) {
      if (snapshot?.current === null || snapshot === undefined) {
        if (snapshot !== undefined) {
          sessions.delete(snapshot.guildId);
        }
        return { content: "Nothing is playing.", embeds: [], components: [] };
      }

      const sessionId = sessionFor(snapshot);
      const track = snapshot.current;
      const title = safeSegment(track.title, 200).trim() || "Untitled track";
      const author = safeSegment(track.author, 100).trim() || "Unknown artist";
      const requester = safeSegment(track.requestedBy.label, 64).trim() || "Unknown user";
      const positionMs = Math.min(snapshot.positionMs, track.durationMs);
      const progress = track.isStream
        ? "🔴 **LIVE**"
        : `${progressBar(positionMs, track.durationMs)}\n\`${formatDuration(positionMs)} / ${formatDuration(track.durationMs)}\``;
      const url = sourceUrl(track.uri);
      const thumbnail = thumbnailUrl(track.identifier);
      const embed = new EmbedBuilder()
        .setColor(PLAYER_COLOR)
        .setAuthor({ name: "Raydio • Now Playing" })
        .setTitle(title)
        .setDescription(`${progress}\n\n**${author}**`)
        .addFields(
          { name: "Requested by", value: requester, inline: true },
          { name: "Up next", value: String(snapshot.upcoming.length), inline: true },
          { name: "Volume", value: `${snapshot.volume}%`, inline: true },
        )
        .setFooter({
          text: `${snapshot.paused ? "Paused" : "Playing"} • ${loopLabel(snapshot.loopMode)} • refreshes every 5 seconds`,
        });
      if (url !== null) {
        embed.setURL(url);
      }
      if (thumbnail !== null) {
        embed.setThumbnail(thumbnail);
      }

      return {
        content: null,
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button(
              sessionId,
              "previous",
              "Previous",
              "⏮️",
              ButtonStyle.Secondary,
              snapshot.historyCount === 0,
            ),
            button(
              sessionId,
              "pause",
              snapshot.paused ? "Resume" : "Pause",
              snapshot.paused ? "▶️" : "⏸️",
              ButtonStyle.Primary,
            ),
            button(
              sessionId,
              "skip",
              "Next",
              "⏭️",
              ButtonStyle.Secondary,
              snapshot.upcoming.length === 0,
            ),
            button(sessionId, "stop", "Stop", "⏹️", ButtonStyle.Danger),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button(sessionId, "queue", "Queue", "📋", ButtonStyle.Secondary),
            button(sessionId, "loop", loopLabel(snapshot.loopMode), "🔁", ButtonStyle.Secondary),
            button(sessionId, "leave", "Leave", "👋", ButtonStyle.Danger),
          ),
        ],
      };
    },

    resolve(guildId, customId, snapshot) {
      if (!isNowPlayingCustomId(customId)) {
        return { kind: "unrelated" };
      }
      const match =
        /^raydio:player:([A-Za-z0-9_-]{1,48}):(leave|loop|pause|previous|queue|skip|stop)$/.exec(
          customId,
        );
      if (match?.[1] === undefined || match[2] === undefined) {
        return { kind: "stale" };
      }
      const session = sessions.get(guildId);
      if (
        snapshot?.current === null ||
        snapshot === undefined ||
        session === undefined ||
        session.id !== match[1] ||
        session.playerToken !== snapshot.playerToken
      ) {
        sessions.delete(guildId);
        return { kind: "stale" };
      }
      return { kind: "ready", action: match[2] as PlayerControlAction };
    },

    retire(guildId) {
      sessions.delete(guildId);
    },
  };
}
