import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import type { ResolvedTrack } from "./music/resolver.js";
import { formatDuration } from "./queue-view.js";
import { escapeExternalText, truncateMessage } from "./utils.js";

const SEARCH_CUSTOM_ID_PREFIX = "raydio:search:";
const SEARCH_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_SESSION_LIMIT = 1_000;
const SEARCH_SESSION_TTL_MS = 60_000;

export interface SearchView {
  readonly content: string;
  readonly components: readonly ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

interface SearchSession {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly voiceChannelId: string;
  readonly tracks: readonly ResolvedTrack[];
  readonly expiresAt: number;
}

export type SearchSelectionResolution =
  | { readonly kind: "unrelated" }
  | { readonly kind: "stale" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "selected";
      readonly track: ResolvedTrack;
      readonly voiceChannelId: string;
    };

export interface SearchViewController {
  render(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly voiceChannelId: string;
    readonly query: string;
    readonly tracks: readonly ResolvedTrack[];
  }): SearchView;
  resolve(input: {
    readonly customId: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly values?: readonly string[];
  }): SearchSelectionResolution;
  retireGuild(guildId: string): void;
}

export function isSearchViewCustomId(customId: string): boolean {
  return customId.startsWith(SEARCH_CUSTOM_ID_PREFIX);
}

function safeSegment(value: string, maximumLength: number): string {
  return truncateMessage(escapeExternalText(value).replaceAll(/\s+/g, " "), maximumLength);
}

function copyTrack(track: ResolvedTrack): ResolvedTrack {
  return { ...track };
}

export function createSearchViewController(
  createSessionId: () => string = randomUUID,
  now: () => number = Date.now,
): SearchViewController {
  const sessions = new Map<string, SearchSession>();

  function pruneExpired(): void {
    const currentTime = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(id);
      }
    }
  }

  function boundedInsert(session: SearchSession): void {
    pruneExpired();
    while (sessions.size >= SEARCH_SESSION_LIMIT) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      sessions.delete(oldest);
    }
    sessions.set(session.id, session);
  }

  return {
    render(input) {
      const tracks = input.tracks.slice(0, SEARCH_RESULT_LIMIT).map(copyTrack);
      if (tracks.length === 0) {
        throw new Error("A search view requires at least one track");
      }
      const id = createSessionId();
      if (!SEARCH_SESSION_ID_PATTERN.test(id)) {
        throw new Error("Search session ID must contain 1-48 URL-safe characters");
      }
      boundedInsert({
        id,
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        voiceChannelId: input.voiceChannelId,
        tracks,
        expiresAt: now() + SEARCH_SESSION_TTL_MS,
      });

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${SEARCH_CUSTOM_ID_PREFIX}${id}:select`)
        .setPlaceholder("Choose a track")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          tracks.map((track, index) => {
            const title = safeSegment(track.title, 95).trim() || "Untitled track";
            const author = safeSegment(track.author, 70).trim() || "Unknown artist";
            return new StringSelectMenuOptionBuilder()
              .setLabel(`${index + 1}. ${title}`)
              .setDescription(`${author} • ${formatDuration(track.durationMs, track.isStream)}`)
              .setValue(String(index));
          }),
        );
      const cancel = new ButtonBuilder()
        .setCustomId(`${SEARCH_CUSTOM_ID_PREFIX}${id}:cancel`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary);

      return {
        content: `Choose a result for **${safeSegment(input.query, 160)}**. This menu expires in 60 seconds.`,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
          new ActionRowBuilder<ButtonBuilder>().addComponents(cancel),
        ],
      };
    },

    resolve(input) {
      if (!isSearchViewCustomId(input.customId)) {
        return { kind: "unrelated" };
      }
      pruneExpired();
      const match = /^raydio:search:([A-Za-z0-9_-]{1,48}):(select|cancel)$/.exec(input.customId);
      if (match?.[1] === undefined || match[2] === undefined) {
        return { kind: "stale" };
      }
      const session = sessions.get(match[1]);
      if (
        session === undefined ||
        session.guildId !== input.guildId ||
        session.channelId !== input.channelId
      ) {
        return { kind: "stale" };
      }
      if (session.userId !== input.userId) {
        return { kind: "forbidden" };
      }
      if (match[2] === "cancel") {
        sessions.delete(session.id);
        return { kind: "cancelled" };
      }

      const selected = input.values?.[0];
      if (selected === undefined || !/^\d+$/.test(selected)) {
        sessions.delete(session.id);
        return { kind: "stale" };
      }
      const track = session.tracks[Number(selected)];
      sessions.delete(session.id);
      return track === undefined
        ? { kind: "stale" }
        : {
            kind: "selected",
            track: copyTrack(track),
            voiceChannelId: session.voiceChannelId,
          };
    },

    retireGuild(guildId) {
      for (const [id, session] of sessions) {
        if (session.guildId === guildId) {
          sessions.delete(id);
        }
      }
    },
  };
}
