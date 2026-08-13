import {
  type ActionRowBuilder,
  ActivityType,
  type AutocompleteInteraction,
  type ButtonBuilder,
  type ButtonInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  type EmbedBuilder,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Message,
  MessageFlags,
  type MessageMentionOptions,
  PermissionFlagsBits,
  type VoiceBasedChannel,
} from "discord.js";
import type { Logger } from "pino";

import {
  APPLICATION_COMMANDS,
  type CommandName,
  dispatchCommand,
  type ExecutableControlCommandInvocation,
} from "./commands.js";
import type { LavalinkReadiness } from "./music/lavalink.js";
import type {
  ControlResult,
  MusicManager,
  PlaybackControlRequest,
  PlayRequestResult,
} from "./music/manager.js";
import type { GuildPlaybackIdentity, GuildPlaybackSnapshot } from "./music/state.js";
import {
  type VoiceAccessFacts,
  type VoiceAccessResult,
  validateControlVoiceAccess,
  validateVoiceAccess,
} from "./music/voice.js";
import {
  createNowPlayingViewController,
  isNowPlayingCustomId,
  type NowPlayingViewController,
} from "./now-playing-view.js";
import {
  createQueueViewController,
  formatDuration,
  isQueueViewCustomId,
  type QueueViewController,
} from "./queue-view.js";
import { errorFields, escapeExternalText, truncateMessage } from "./utils.js";

export const DISCORD_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
] as const;

export const SAFE_ALLOWED_MENTIONS = {
  parse: [],
  repliedUser: false,
} as const satisfies MessageMentionOptions;

export interface DiscordService {
  readonly client: Client;
  start(token: string): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordMusicNotifier {
  send(channelId: string, content: string): Promise<void>;
}

type MusicController = Pick<
  MusicManager,
  | "cleanupUnexpected"
  | "getIdentities"
  | "getIdentity"
  | "getSnapshot"
  | "searchTracks"
  | "requestPlay"
  | "setPaused"
  | "setVolume"
  | "setLoopMode"
  | "removeUpcoming"
  | "moveUpcoming"
  | "clearUpcoming"
  | "shuffleUpcoming"
  | "jump"
  | "previous"
  | "skip"
  | "stop"
  | "leave"
  | "updateAloneStatus"
>;

const AUTOCOMPLETE_RESULT_LIMIT = 10;
const AUTOCOMPLETE_CACHE_LIMIT = 500;
const AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const AUTOCOMPLETE_DEADLINE_MS = 2_250;
const PLAYER_REFRESH_INTERVAL_MS = 1_000;
const PLAYER_MESSAGE_LIMIT = 1_000;

type SlashResponseSender = (options: {
  readonly content?: string | null;
  readonly embeds?: readonly EmbedBuilder[];
  readonly components?: readonly ActionRowBuilder<ButtonBuilder>[];
}) => Promise<Message>;

interface DeletableMessage {
  readonly id: string;
  delete(): Promise<unknown>;
}

interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

export async function deleteSupersededPlayerMessage(
  previous: DeletableMessage | undefined,
  current: DeletableMessage,
): Promise<boolean> {
  if (previous === undefined || previous.id === current.id) {
    return false;
  }
  await previous.delete();
  return true;
}

export function isTerminalPlayerMessageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === 10_003 || code === 10_008 || code === 50_001 || code === 50_013;
}

export function hasHumanVoiceMember(
  members: Iterable<{ readonly user: { readonly bot: boolean } }>,
): boolean {
  for (const member of members) {
    if (!member.user.bot) {
      return true;
    }
  }
  return false;
}

function logError(logger: Logger, event: string, error: unknown, message: string): void {
  logger.error({ event, ...errorFields(error) }, message);
}

function plainExternalText(value: string, maximumLength: number): string {
  const plain = value
    .replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return truncateMessage(plain, maximumLength);
}

function isSearchableAutocompleteInput(input: string): boolean {
  const query = input.trim();
  if (query.length < 2) {
    return false;
  }
  try {
    new URL(query);
    return false;
  } catch {
    return true;
  }
}

export function createPlayAutocompleteHandler(
  music: MusicController,
  now: () => number = Date.now,
): (interaction: AutocompleteInteraction) => Promise<void> {
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly choices: readonly AutocompleteChoice[] }
  >();

  function prune(): void {
    const currentTime = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= currentTime) {
        cache.delete(key);
      }
    }
    while (cache.size > AUTOCOMPLETE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  return async (interaction) => {
    if (!interaction.inCachedGuild() || interaction.commandName !== "play") {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().trim();
    if (!isSearchableAutocompleteInput(query)) {
      await interaction.respond([]);
      return;
    }
    const access = validateVoiceAccess(interactionVoiceFacts(interaction));
    if (access.kind !== "ready") {
      await interaction.respond([]);
      return;
    }

    prune();
    const key = `${interaction.guildId}:${access.voiceChannelId}:${query.toLocaleLowerCase("en-US")}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      await interaction.respond(cached.choices);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), AUTOCOMPLETE_DEADLINE_MS);
      timeout.unref();
    });
    const result = await Promise.race([
      music.searchTracks({
        guildId: interaction.guildId,
        intendedVoiceChannelId: access.voiceChannelId,
        input: query,
        resultLimit: AUTOCOMPLETE_RESULT_LIMIT,
      }),
      deadline,
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    if (result === null) {
      await interaction.respond([]);
      return;
    }
    const seenIdentifiers = new Set<string>();
    const choices: AutocompleteChoice[] = [];
    if (result.kind === "choices") {
      for (const track of result.tracks) {
        const value = `https://www.youtube.com/watch?v=${track.identifier}`;
        if (value.length > 100 || seenIdentifiers.has(track.identifier)) {
          continue;
        }
        seenIdentifiers.add(track.identifier);
        choices.push({
          name:
            plainExternalText(`${track.title} — ${track.author}`, 100) || "Untitled YouTube track",
          value,
        });
      }
    }
    cache.set(key, { choices, expiresAt: now() + AUTOCOMPLETE_CACHE_TTL_MS });
    prune();
    await interaction.respond(choices);
  };
}

function commandArgument(interaction: ChatInputCommandInteraction<"cached">): string {
  switch (interaction.commandName as CommandName) {
    case "play":
      return interaction.options.getString("request", true);
    case "volume":
      return interaction.options.getInteger("level")?.toString() ?? "";
    case "loop":
      return interaction.options.getString("mode", true);
    case "remove":
    case "jump":
      return interaction.options.getInteger("position", true).toString();
    case "move":
      return `${interaction.options.getInteger("from", true)} ${interaction.options.getInteger("to", true)}`;
    default:
      return "";
  }
}

async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  logger: Logger,
  lavalink: LavalinkReadiness,
  music: MusicController,
  queueViews: QueueViewController,
  playerViews: NowPlayingViewController,
  registerPlayerMessage: (guildId: string, message: Message) => Promise<void>,
  refreshPlayerMessage: (guildId: string) => Promise<void>,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Raydio commands are available only in a loaded server.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const parsed = { name: interaction.commandName, argument: commandArgument(interaction) };

  logger.debug(
    {
      event: "command_received",
      command: parsed.name,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    },
    "Discord command received",
  );

  try {
    await interaction.deferReply();
    let responded = false;
    const send: SlashResponseSender = async (options) => {
      const payload = {
        ...(options.content === undefined || options.content === null
          ? {}
          : { content: options.content }),
        ...(options.embeds === undefined ? {} : { embeds: options.embeds }),
        ...(options.components === undefined ? {} : { components: options.components }),
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      };
      if (!responded) {
        responded = true;
        return interaction.editReply(payload);
      }
      return interaction.followUp(payload);
    };

    await dispatchCommand(parsed, {
      discordLatencyMs: interaction.client.ws.ping,
      discordReady: interaction.client.isReady(),
      lavalinkReady: lavalink.isReady(),
      play: async (input) =>
        handlePlay(interaction, input, music, playerViews, registerPlayerMessage, send),
      control: async (invocation) => handleControl(interaction, invocation, music),
      presentNowPlaying: async () => {
        const view = playerViews.render(music.getSnapshot(interaction.guildId));
        const sent = await send({
          content: view.content,
          embeds: view.embeds,
          components: view.components,
        });
        if (view.components.length > 0) {
          await registerPlayerMessage(interaction.guildId, sent);
        }
      },
      presentQueue: async () => {
        const view = queueViews.render(music.getSnapshot(interaction.guildId));
        await send({
          content: view.content,
          components: view.components,
        });
      },
      send: async (content) => {
        await send({ content: truncateMessage(content) });
      },
    });
    await refreshPlayerMessage(interaction.guildId);
  } catch (error: unknown) {
    logError(logger, "command_failed", error, "Discord command failed");

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "The command could not be completed." });
      } else {
        await interaction.reply({
          content: "The command could not be completed.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
      }
    } catch (sendError: unknown) {
      logger.warn(
        { event: "command_error_response_failed", ...errorFields(sendError) },
        "Could not send command error response",
      );
    }
  }
}

export async function handleQueueButtonInteraction(
  interaction: ButtonInteraction,
  music: MusicController,
  queueViews: QueueViewController,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Queue controls are available only in a server.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const resolution = queueViews.resolve(
    interaction.guildId,
    interaction.customId,
    music.getSnapshot(interaction.guildId),
  );
  if (resolution.kind === "unrelated") {
    return;
  }
  if (resolution.kind === "stale") {
    await interaction.update({
      content: "This queue view is no longer active. Run `/queue` again.",
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  await interaction.update({
    content: resolution.view.content,
    components: resolution.view.components,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
}

function prepareInteractionControl(
  interaction: ButtonInteraction<"cached"> | ChatInputCommandInteraction<"cached">,
  music: MusicController,
  allowMissingSession = false,
): PlaybackControlRequest | { readonly message: string } {
  const identity = music.getIdentity(interaction.guildId);
  const access = validateControlVoiceAccess(
    interactionVoiceFacts(interaction),
    identity?.voiceChannelId ?? null,
    allowMissingSession,
  );
  if (access.kind !== "ready") {
    switch (access.kind) {
      case "not-in-voice":
        return { message: "Join the bot's voice channel before using that control." };
      case "unsupported-channel":
        return { message: "Stage channels are not supported. Join a normal voice channel." };
      case "no-session":
        return { message: "There is no active music session." };
      case "wrong-channel":
        return { message: "Join the bot's current voice channel before using that control." };
    }
  }
  return {
    guildId: interaction.guildId,
    intendedVoiceChannelId: access.voiceChannelId,
    playerToken: identity?.playerToken ?? null,
    validateCommit: () => {
      const current = interaction.guild.members.cache.get(interaction.user.id);
      return (
        current?.voice.channel?.type === ChannelType.GuildVoice &&
        current.voice.channel.id === access.voiceChannelId
      );
    },
  };
}

function nextLoopMode(mode: GuildPlaybackSnapshot["loopMode"]): GuildPlaybackSnapshot["loopMode"] {
  return mode === "off" ? "track" : "off";
}

export async function handlePlayerButtonInteraction(
  interaction: ButtonInteraction,
  music: MusicController,
  queueViews: QueueViewController,
  playerViews: NowPlayingViewController,
  retirePlayerMessage: (guildId: string) => void,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Player controls are available only in a loaded server.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  const snapshot = music.getSnapshot(interaction.guildId);
  const resolution = playerViews.resolve(interaction.guildId, interaction.customId, snapshot);
  if (resolution.kind === "unrelated") {
    return;
  }
  if (resolution.kind === "stale") {
    await interaction.update({
      content: "These player controls are no longer active. Run `/nowplaying` again.",
      embeds: [],
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  if (resolution.action === "queue") {
    const view = queueViews.render(snapshot);
    await interaction.reply({
      content: view.content,
      components: view.components,
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const prepared = prepareInteractionControl(
    interaction,
    music,
    resolution.action === "stop" || resolution.action === "leave",
  );
  if ("message" in prepared) {
    await interaction.reply({
      content: prepared.message,
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  await interaction.deferUpdate();
  let failure: string | null = null;
  let terminalMessage: string | null = null;

  if (resolution.action === "pause") {
    const result = await music.setPaused(prepared, !(snapshot?.paused ?? false));
    failure = controlFailure(result);
  } else if (resolution.action === "loop") {
    const result = await music.setLoopMode(prepared, nextLoopMode(snapshot?.loopMode ?? "off"));
    failure = controlFailure(result);
  } else if (resolution.action === "previous") {
    const result = await music.previous(prepared);
    failure = controlFailure(result);
    if (failure === null && result.kind === "ok" && result.value === null) {
      failure = "There is no previous track in this session.";
    }
  } else if (resolution.action === "skip") {
    const result = await music.skip(prepared);
    failure = controlFailure(result);
  } else if (resolution.action === "stop") {
    const result = await music.stop(prepared);
    failure = controlFailure(result);
    if (failure === null) {
      terminalMessage = "Playback stopped and the upcoming queue was cleared.";
    }
  } else {
    const result = await music.leave(prepared);
    failure = controlFailure(result);
    if (failure === null) {
      terminalMessage = "Left the voice channel and cleared the session.";
    }
  }

  if (failure !== null) {
    await interaction.followUp({
      content: failure,
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
  }
  if (terminalMessage !== null) {
    playerViews.retire(interaction.guildId);
    retirePlayerMessage(interaction.guildId);
    await interaction.editReply({
      content: terminalMessage,
      embeds: [],
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const view = playerViews.render(music.getSnapshot(interaction.guildId));
  await interaction.editReply({
    content: view.content,
    embeds: view.embeds,
    components: view.components,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
}

function memberVoiceFacts(
  member: GuildMember | null,
  botMember: GuildMember | null,
): VoiceAccessFacts {
  const channel = member?.voice.channel ?? null;
  const permissions =
    channel !== null && botMember !== null ? channel.permissionsFor(botMember) : null;

  return {
    channelId: channel?.id ?? null,
    channelKind:
      channel === null
        ? null
        : channel.type === ChannelType.GuildVoice
          ? "voice"
          : channel.type === ChannelType.GuildStageVoice
            ? "stage"
            : "unsupported",
    botMemberAvailable: botMember !== null,
    botInChannel: channel !== null && botMember?.voice.channelId === channel.id,
    channelFull: channel?.full ?? false,
    canView: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
    canConnect: permissions?.has(PermissionFlagsBits.Connect) ?? false,
    canSpeak: permissions?.has(PermissionFlagsBits.Speak) ?? false,
  };
}

function interactionVoiceFacts(
  interaction:
    | AutocompleteInteraction<"cached">
    | ButtonInteraction<"cached">
    | ChatInputCommandInteraction<"cached">,
): VoiceAccessFacts {
  return memberVoiceFacts(
    interaction.guild.members.cache.get(interaction.user.id) ?? null,
    interaction.guild.members.me,
  );
}

function voiceAccessMessage(result: VoiceAccessResult): string {
  switch (result.kind) {
    case "ready":
    case "voice-changed":
      return "Your voice channel changed before the song could be queued.";
    case "not-in-voice":
      return "Join a voice channel before using `/play`.";
    case "unsupported-channel":
      return "Stage channels are not supported. Join a normal voice channel.";
    case "bot-member-unavailable":
      return "Discord has not finished loading the bot's server membership. Try again shortly.";
    case "missing-permissions":
      return `I need these permissions in your voice channel: ${result.permissions.join(", ")}.`;
    case "channel-full":
      return "That voice channel is full, so I cannot join it.";
  }
}

function resolutionFailureMessage(
  result: Extract<PlayRequestResult, { kind: "not-queued" }>,
): string {
  switch (result.resolution.kind) {
    case "no-match":
      return "No suitable YouTube result was found.";
    case "capacity-exhausted":
      return "The queue is full.";
    case "unavailable":
      return "Music service is temporarily unavailable.";
    case "unsupported-url":
      return "Only YouTube and YouTube Music URLs are supported.";
    case "failure":
      return "YouTube could not load that request. Try another song.";
  }
}

export function formatPlayRequestResult(result: PlayRequestResult): string {
  switch (result.kind) {
    case "queued": {
      const title = truncateMessage(escapeExternalText(result.firstTrack.title), 160);
      const author = truncateMessage(escapeExternalText(result.firstTrack.author), 100);
      const duration = result.firstTrack.isStream
        ? "LIVE"
        : formatDuration(result.firstTrack.durationMs);
      const playlistName =
        result.playlistName === null
          ? null
          : truncateMessage(escapeExternalText(result.playlistName), 120);
      let message: string;
      if (result.becameCurrent) {
        message = `Playing **${title}** by **${author}** (\`${duration}\`)`;
        if (result.addedTrackCount > 1) {
          message += ` and queued ${result.addedTrackCount - 1} more`;
        }
      } else if (result.addedTrackCount === 1) {
        message = `Queued **${title}** by **${author}** (\`${duration}\`)`;
      } else {
        message = `Queued ${result.addedTrackCount} tracks`;
      }
      if (playlistName !== null && result.addedTrackCount > 1) {
        message += ` from **${playlistName}**`;
      }
      message += ".";

      const omitted = result.truncatedTrackCount + result.commitTruncatedTrackCount;
      const notes: string[] = [];
      if (omitted > 0) {
        notes.push(`${omitted} omitted by queue limits`);
      }
      if (result.rejectedTrackCount > 0) {
        notes.push(`${result.rejectedTrackCount} unsuitable`);
      }
      return notes.length === 0 ? message : `${message} ${notes.join("; ")}.`;
    }
    case "not-queued":
      return resolutionFailureMessage(result);
    case "pending-limit":
      return "Too many play requests are already pending for this server.";
    case "stale":
      return "That play request was canceled by a newer stop or disconnect.";
    case "commit-rejected":
      return voiceAccessMessage(result.reason);
    case "wrong-channel":
      return "Join the bot's current voice channel before adding music.";
    case "queue-full":
      return "The queue is full.";
    case "join-failed":
      return "I could not join that voice channel. Check its permissions and try again.";
    case "play-failed":
      return "I joined, but Lavalink could not start that track.";
    case "closed":
      return "Music service is shutting down.";
  }
}

function safeSegment(value: string, maximumLength: number): string {
  return truncateMessage(escapeExternalText(value).replaceAll(/\s+/g, " "), maximumLength);
}

export function formatNowPlayingSnapshot(snapshot: GuildPlaybackSnapshot | undefined): string {
  if (snapshot?.current === null || snapshot === undefined) {
    return "Nothing is playing.";
  }
  const track = snapshot.current;
  const title = safeSegment(track.title, 160);
  const author = safeSegment(track.author, 100);
  const requester = safeSegment(track.requestedBy.label, 64);
  const progress = track.isStream
    ? "LIVE"
    : `${formatDuration(Math.min(snapshot.positionMs, track.durationMs))} / ${formatDuration(track.durationMs)}`;
  return truncateMessage(
    [
      `Now playing: **${title}** — ${author}`,
      `Requested by: ${requester}`,
      `Progress: ${progress}`,
      `Status: ${snapshot.paused ? "paused" : "playing"} • Loop: ${snapshot.loopMode} • Volume: ${snapshot.volume}%`,
    ].join("\n"),
  );
}

function controlFailure(result: ControlResult<unknown>): string | null {
  if (result.kind === "transport-failed") {
    return "Lavalink could not apply that playback change.";
  }
  if (result.kind === "ok") {
    return null;
  }
  switch (result.reason) {
    case "no-session":
    case "stale-session":
      return "The music session changed before that control could be applied.";
    case "wrong-channel":
      return "Join the bot's current voice channel before using that control.";
    case "voice-changed":
      return "Your voice channel changed before that control could be applied.";
  }
}

function formatStartedTrackNote(result: Extract<PlayRequestResult, { kind: "queued" }>): string {
  const notes: string[] = [];
  if (result.addedTrackCount > 1) {
    const playlist =
      result.playlistName === null
        ? ""
        : ` from **${truncateMessage(escapeExternalText(result.playlistName), 120)}**`;
    notes.push(`Queued ${result.addedTrackCount - 1} more${playlist}.`);
  }
  const omitted = result.truncatedTrackCount + result.commitTruncatedTrackCount;
  if (omitted > 0) {
    notes.push(`${omitted} track${omitted === 1 ? " was" : "s were"} omitted by queue limits.`);
  }
  if (result.rejectedTrackCount > 0) {
    notes.push(
      `${result.rejectedTrackCount} unsuitable track${result.rejectedTrackCount === 1 ? " was" : "s were"} omitted.`,
    );
  }
  return notes.join(" ");
}

function playerContent(result: Extract<PlayRequestResult, { kind: "queued" }>): string | null {
  const note = formatStartedTrackNote(result);
  return note.length === 0 ? null : truncateMessage(note);
}

async function handleControl(
  interaction: ChatInputCommandInteraction<"cached">,
  invocation: ExecutableControlCommandInvocation,
  music: MusicController,
): Promise<string> {
  if (invocation.name === "volume" && invocation.volume === null) {
    const snapshot = music.getSnapshot(interaction.guildId);
    return snapshot === undefined
      ? "There is no active music session."
      : `Current volume: ${snapshot.volume}%.`;
  }

  const prepared = prepareInteractionControl(
    interaction,
    music,
    invocation.name === "stop" || invocation.name === "leave",
  );
  if ("message" in prepared) {
    return prepared.message;
  }

  if (invocation.name === "pause" || invocation.name === "resume") {
    const paused = invocation.name === "pause";
    const result = await music.setPaused(prepared, paused);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected pause control result");
    }
    if (result.value === "no-current") {
      return "Nothing is playing.";
    }
    if (result.value === "unchanged") {
      return paused ? "Playback is already paused." : "Playback is already running.";
    }
    return paused ? "Playback paused." : "Playback resumed.";
  }

  if (invocation.name === "volume") {
    if (invocation.volume === null) {
      throw new Error("Volume query unexpectedly reached the update path");
    }
    const result = await music.setVolume(prepared, invocation.volume);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected volume control result");
    }
    return result.value.changed
      ? `Volume set to ${result.value.volume}%.`
      : `Volume is already ${result.value.volume}%.`;
  }

  if (invocation.name === "loop") {
    const result = await music.setLoopMode(prepared, invocation.mode);
    return controlFailure(result) ?? `Loop mode set to ${invocation.mode}.`;
  }

  if (invocation.name === "remove") {
    const result = await music.removeUpcoming(prepared, invocation.displayedIndex);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected remove control result");
    }
    return result.value === null
      ? "There is no upcoming track at that index."
      : `Removed **${safeSegment(result.value.title, 160)}**.`;
  }

  if (invocation.name === "move") {
    const result = await music.moveUpcoming(prepared, invocation.fromIndex, invocation.toIndex);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected move control result");
    }
    if (result.value === null) {
      return "One of those upcoming queue positions does not exist.";
    }
    return result.value.changed
      ? `Moved **${safeSegment(result.value.track.title, 160)}** from ${invocation.fromIndex} to ${invocation.toIndex}.`
      : `**${safeSegment(result.value.track.title, 160)}** is already at position ${invocation.fromIndex}.`;
  }

  if (invocation.name === "clear") {
    const result = await music.clearUpcoming(prepared);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected clear control result");
    }
    return result.value === 0
      ? "The upcoming queue is already empty."
      : `Cleared ${result.value} upcoming track${result.value === 1 ? "" : "s"}.`;
  }

  if (invocation.name === "shuffle") {
    const result = await music.shuffleUpcoming(prepared);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected shuffle control result");
    }
    return result.value
      ? "Shuffled the upcoming queue."
      : "At least two upcoming tracks are needed.";
  }

  if (invocation.name === "previous") {
    const result = await music.previous(prepared);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected previous control result");
    }
    return result.value === null
      ? "There is no previous track in this session."
      : `Now playing **${safeSegment(result.value.title, 160)}**.`;
  }

  if (invocation.name === "jump") {
    const result = await music.jump(prepared, invocation.displayedIndex);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected jump control result");
    }
    if (result.value === null) {
      return "There is no upcoming song at that position.";
    }
    const transition = result.value;
    return transition.kind === "advanced" && transition.current !== null
      ? `Jumped to **${safeSegment(transition.current.title, 160)}**.`
      : "The selected song could not be started.";
  }

  if (invocation.name === "skip") {
    const result = await music.skip(prepared);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    if (result.kind !== "ok") {
      throw new Error("Unexpected skip control result");
    }
    const transition = result.value;
    if (transition.kind === "ignored") {
      return transition.reason === "no-current"
        ? "Nothing is playing."
        : "The current track changed before it could be skipped.";
    }
    if (transition.kind === "failure-guard") {
      return "Playback stopped after repeated track failures.";
    }
    return transition.current === null
      ? "Skipped. The queue is now empty."
      : `Skipped. Now playing **${safeSegment(transition.current.title, 160)}**.`;
  }

  if (invocation.name === "stop") {
    const result = await music.stop(prepared);
    const failure = controlFailure(result);
    if (failure !== null) {
      return failure;
    }
    return result.kind === "ok" && result.value === "stopped"
      ? "Playback stopped and the upcoming queue was cleared."
      : "Playback is already stopped.";
  }

  const result = await music.leave(prepared);
  const failure = controlFailure(result);
  if (failure !== null) {
    return failure;
  }
  return result.kind === "ok" && result.value
    ? "Left the voice channel and cleared the session."
    : "There is no active music session.";
}

async function handlePlay(
  interaction: ChatInputCommandInteraction<"cached">,
  input: string,
  music: MusicController,
  playerViews: NowPlayingViewController,
  registerPlayerMessage: (guildId: string, message: Message) => Promise<void>,
  send: SlashResponseSender,
): Promise<string | null> {
  const initialAccess = validateVoiceAccess(interactionVoiceFacts(interaction));
  if (initialAccess.kind !== "ready") {
    return voiceAccessMessage(initialAccess);
  }

  const result = await music.requestPlay({
    guildId: interaction.guildId,
    notificationChannelId: interaction.channelId,
    intendedVoiceChannelId: initialAccess.voiceChannelId,
    shardId: interaction.guild.shardId,
    input,
    requestedBy: {
      id: interaction.user.id,
      label: interaction.member.displayName,
    },
    validateCommit: () =>
      validateVoiceAccess(interactionVoiceFacts(interaction), initialAccess.voiceChannelId),
  });
  if (result.kind === "queued") {
    const identity = music.getIdentity(interaction.guildId);
    const channel = interaction.guild.channels.cache.get(initialAccess.voiceChannelId);
    if (
      identity !== undefined &&
      identity.voiceChannelId === initialAccess.voiceChannelId &&
      channel?.isVoiceBased()
    ) {
      await music.updateAloneStatus(
        identity.guildId,
        identity.playerToken,
        !hasHumanVoiceMember(channel.members.values()),
      );
    }
  }
  const summary = formatPlayRequestResult(result);
  if (result.kind !== "queued" || !result.becameCurrent) {
    return summary;
  }

  const view = playerViews.render(music.getSnapshot(interaction.guildId));
  const sent = await send({
    content: playerContent(result),
    embeds: view.embeds,
    components: view.components,
  });
  if (view.components.length > 0) {
    await registerPlayerMessage(interaction.guildId, sent);
  }
  return null;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: DISCORD_INTENTS,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
}

export function createDiscordMusicNotifier(client: Client): DiscordMusicNotifier {
  return {
    async send(channelId, content) {
      const channel = client.channels.cache.get(channelId);
      if (channel === undefined || !channel.isSendable()) {
        throw new Error("The playback notification channel is unavailable");
      }
      await channel.send({
        content: truncateMessage(content),
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
    },
  };
}

export function createDiscordService(
  client: Client,
  logger: Logger,
  lavalink: LavalinkReadiness,
  music: MusicController,
): DiscordService {
  const queueViews = createQueueViewController();
  const playerViews = createNowPlayingViewController();
  const handleAutocomplete = createPlayAutocompleteHandler(music);
  const playerMessages = new Map<string, { readonly message: Message; fingerprint: string }>();
  const playerMessageRefreshes = new Set<string>();
  let presenceKey = "";
  let acceptingCommands = false;
  let started = false;
  let stopped = false;

  function retirePlayerMessage(guildId: string): void {
    playerMessages.delete(guildId);
  }

  async function registerPlayerMessage(guildId: string, message: Message): Promise<void> {
    const previous = playerMessages.get(guildId);
    if (previous === undefined && playerMessages.size >= PLAYER_MESSAGE_LIMIT) {
      const oldestGuildId = playerMessages.keys().next().value;
      if (oldestGuildId !== undefined) {
        const oldestMessage = playerMessages.get(oldestGuildId)?.message;
        playerMessages.delete(oldestGuildId);
        void oldestMessage?.edit({ components: [] }).catch(() => undefined);
      }
    }
    playerMessages.set(guildId, { message, fingerprint: "" });
    if (previous !== undefined && previous.message.id !== message.id) {
      await deleteSupersededPlayerMessage(previous.message, message).catch((error: unknown) => {
        logger.debug(
          { event: "player_previous_message_delete_failed", ...errorFields(error) },
          "Could not delete a superseded player message",
        );
      });
    }
  }

  async function refreshPlayerMessage(guildId: string): Promise<void> {
    if (playerMessageRefreshes.has(guildId)) {
      return;
    }
    const active = playerMessages.get(guildId);
    if (active === undefined) {
      return;
    }
    playerMessageRefreshes.add(guildId);
    try {
      const view = playerViews.render(music.getSnapshot(guildId));
      const fingerprint = JSON.stringify({
        content: view.content,
        embeds: view.embeds.map((embed) => embed.toJSON()),
        components: view.components.map((row) => row.toJSON()),
      });
      if (active.fingerprint === fingerprint) {
        return;
      }
      await active.message.edit({
        content: view.content,
        embeds: view.embeds,
        components: view.components,
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
      if (playerMessages.get(guildId) !== active) {
        return;
      }
      active.fingerprint = fingerprint;
      if (view.components.length === 0) {
        retirePlayerMessage(guildId);
      }
    } catch (error: unknown) {
      const terminal = isTerminalPlayerMessageError(error);
      if (terminal && playerMessages.get(guildId) === active) {
        retirePlayerMessage(guildId);
        playerViews.retire(guildId);
      }
      logger.debug(
        {
          event: "player_message_refresh_failed",
          guildId,
          terminal,
          ...errorFields(error),
        },
        "Could not refresh the active player message",
      );
    } finally {
      playerMessageRefreshes.delete(guildId);
    }
  }

  function refreshPresence(): void {
    const identities = music.getIdentities();
    const snapshot =
      identities.length === 1 ? music.getSnapshot(identities[0]?.guildId ?? "") : undefined;
    const singleGuildTrack = client.guilds.cache.size === 1 ? snapshot?.current : undefined;
    const nextPresence =
      singleGuildTrack == null
        ? identities.length === 0
          ? { key: "idle", name: "/play", type: ActivityType.Watching }
          : {
              key: `active:${identities.length}`,
              name: `${identities.length} active session${identities.length === 1 ? "" : "s"}`,
              type: ActivityType.Listening,
            }
        : {
            key: `track:${singleGuildTrack.identifier}`,
            name: plainExternalText(singleGuildTrack.title, 100) || "music",
            type: ActivityType.Listening,
          };
    if (client.user === null || presenceKey === nextPresence.key) {
      return;
    }
    client.user.setActivity(nextPresence.name, { type: nextPresence.type });
    presenceKey = nextPresence.key;
  }

  const playerRefreshTimer = setInterval(() => {
    for (const guildId of playerMessages.keys()) {
      void refreshPlayerMessage(guildId);
    }
    refreshPresence();
  }, PLAYER_REFRESH_INTERVAL_MS);
  playerRefreshTimer.unref();

  function cleanupUnexpected(guildId: string): void {
    queueViews.retire(guildId);
    playerViews.retire(guildId);
    const playerMessage = playerMessages.get(guildId)?.message;
    retirePlayerMessage(guildId);
    if (playerMessage !== undefined) {
      void playerMessage.edit({ components: [] }).catch(() => undefined);
    }
    void music.cleanupUnexpected(guildId).catch((error: unknown) => {
      logError(logger, "unexpected_voice_cleanup_failed", error, "Voice cleanup failed");
    });
  }

  function updateAloneStatus(identity: GuildPlaybackIdentity, channel: VoiceBasedChannel): void {
    const alone = !hasHumanVoiceMember(channel.members.values());
    void music
      .updateAloneStatus(identity.guildId, identity.playerToken, alone)
      .catch((error: unknown) => {
        logError(logger, "alone_status_update_failed", error, "Alone status update failed");
      });
  }

  function reconcileIdentity(identity: GuildPlaybackIdentity): void {
    const guild = client.guilds.cache.get(identity.guildId);
    if (guild === undefined) {
      return;
    }
    if (guild.members.me?.voice.channelId !== identity.voiceChannelId) {
      cleanupUnexpected(identity.guildId);
      return;
    }
    const channel = guild.channels.cache.get(identity.voiceChannelId);
    if (channel === undefined || !channel.isVoiceBased()) {
      cleanupUnexpected(identity.guildId);
      return;
    }
    updateAloneStatus(identity, channel);
  }

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        event: "discord_ready",
        botUserId: readyClient.user.id,
        guildCount: readyClient.guilds.cache.size,
      },
      "Discord client ready",
    );
  });

  client.on(Events.Error, (error) => {
    logError(logger, "discord_error", error, "Discord client error");
  });

  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    logger.warn(
      {
        event: "discord_shard_disconnected",
        shardId,
        closeCode: closeEvent.code,
      },
      "Discord shard disconnected",
    );
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info({ event: "discord_shard_reconnecting", shardId }, "Discord shard reconnecting");
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info(
      { event: "discord_shard_resumed", shardId, replayedEvents },
      "Discord shard resumed",
    );
    for (const identity of music.getIdentities()) {
      const guild = client.guilds.cache.get(identity.guildId);
      if (guild?.shardId === shardId) {
        reconcileIdentity(identity);
      }
    }
  });

  client.on(Events.GuildDelete, (guild) => {
    cleanupUnexpected(guild.id);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      void handleAutocomplete(interaction).catch((error: unknown) => {
        logger.debug(
          { event: "autocomplete_failed", ...errorFields(error) },
          "Could not provide play suggestions",
        );
      });
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (!acceptingCommands) {
        void interaction
          .reply({
            content: "Raydio is not accepting commands right now.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: SAFE_ALLOWED_MENTIONS,
          })
          .catch(() => undefined);
        return;
      }
      void handleChatInputCommand(
        interaction,
        logger,
        lavalink,
        music,
        queueViews,
        playerViews,
        registerPlayerMessage,
        refreshPlayerMessage,
      );
      return;
    }

    const isQueueInteraction = interaction.isButton() && isQueueViewCustomId(interaction.customId);
    const isPlayerInteraction =
      interaction.isButton() && isNowPlayingCustomId(interaction.customId);
    if (!isQueueInteraction && !isPlayerInteraction) {
      return;
    }
    if (!acceptingCommands) {
      void interaction
        .reply({
          content: "Raydio is not accepting controls right now.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        })
        .catch((error: unknown) => {
          logError(logger, "component_interaction_reply_failed", error, "Interaction failed");
        });
      return;
    }

    let operation: Promise<void>;
    if (interaction.isButton() && isNowPlayingCustomId(interaction.customId)) {
      operation = handlePlayerButtonInteraction(
        interaction,
        music,
        queueViews,
        playerViews,
        retirePlayerMessage,
      );
    } else if (interaction.isButton()) {
      operation = handleQueueButtonInteraction(interaction, music, queueViews);
    } else {
      return;
    }
    void operation.catch((error: unknown) => {
      logError(logger, "component_interaction_failed", error, "Discord interaction failed");
      if (!interaction.replied && !interaction.deferred) {
        void interaction
          .reply({
            content: "That control could not be completed.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: SAFE_ALLOWED_MENTIONS,
          })
          .catch((replyError: unknown) => {
            logError(
              logger,
              "component_interaction_error_reply_failed",
              replyError,
              "Could not send interaction error response",
            );
          });
      }
    });
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const identity = music.getIdentity(newState.guild.id);
    if (identity === undefined) {
      return;
    }

    const botUserId = newState.guild.members.me?.id ?? client.user?.id;
    if (newState.id === botUserId) {
      if (newState.channelId !== identity.voiceChannelId) {
        cleanupUnexpected(newState.guild.id);
      } else {
        reconcileIdentity(identity);
      }
      return;
    }

    if (
      oldState.channelId !== identity.voiceChannelId &&
      newState.channelId !== identity.voiceChannelId
    ) {
      return;
    }
    const channel = newState.guild.channels.cache.get(identity.voiceChannelId);
    if (channel === undefined || !channel.isVoiceBased()) {
      cleanupUnexpected(newState.guild.id);
      return;
    }
    updateAloneStatus(identity, channel);
  });

  return {
    client,
    async start(token: string): Promise<void> {
      if (stopped) {
        throw new Error("Discord service has already been stopped");
      }
      if (started) {
        throw new Error("Discord service has already been started");
      }

      started = true;

      try {
        await client.login(token);
        if (client.application === null) {
          throw new Error("Discord application metadata is unavailable after login");
        }
        const registered = await client.application.commands.set(
          APPLICATION_COMMANDS.map((applicationCommand) => applicationCommand.toJSON()),
        );
        logger.info(
          { event: "application_commands_ready", commandCount: registered.size },
          "Discord application commands synchronized",
        );
        acceptingCommands = true;
        refreshPresence();
      } catch (error: unknown) {
        acceptingCommands = false;
        client.destroy();
        throw error;
      }
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      acceptingCommands = false;
      clearInterval(playerRefreshTimer);
      playerMessages.clear();
      playerMessageRefreshes.clear();
      await client.destroy();
    },
  };
}
