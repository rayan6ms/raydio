import {
  type ButtonInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Message,
  MessageFlags,
  type MessageMentionOptions,
  PermissionFlagsBits,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from "discord.js";
import type { Logger } from "pino";

import {
  dispatchCommand,
  type ExecutableControlCommandInvocation,
  parseCommand,
} from "./commands.js";
import type { LavalinkReadiness } from "./music/lavalink.js";
import type {
  ControlResult,
  MusicManager,
  PlaybackControlRequest,
  PlayRequestResult,
  SearchTracksResult,
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
import {
  createSearchViewController,
  isSearchViewCustomId,
  type SearchSelectionResolution,
  type SearchViewController,
} from "./search-view.js";
import { errorFields, escapeExternalText, truncateMessage } from "./utils.js";

export const DISCORD_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.MessageContent,
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
  | "clearUpcoming"
  | "shuffleUpcoming"
  | "previous"
  | "skip"
  | "stop"
  | "leave"
  | "updateAloneStatus"
>;

const SEARCH_RESULT_LIMIT = 5;
const PLAYER_REFRESH_INTERVAL_MS = 15_000;
const PLAYER_MESSAGE_LIMIT = 1_000;

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

async function handleMessage(
  message: Message,
  logger: Logger,
  lavalink: LavalinkReadiness,
  music: MusicController,
  queueViews: QueueViewController,
  searchViews: SearchViewController,
  playerViews: NowPlayingViewController,
  registerPlayerMessage: (guildId: string, message: Message) => void,
  refreshPlayerMessage: (guildId: string) => Promise<void>,
): Promise<void> {
  if (!message.inGuild()) {
    return;
  }

  const parsed = parseCommand({
    authorIsBot: message.author.bot,
    content: message.content,
    guildId: message.guildId,
  });

  if (parsed === null) {
    return;
  }

  logger.debug(
    {
      event: "command_received",
      command: parsed.name,
      guildId: message.guildId,
      userId: message.author.id,
    },
    "Discord command received",
  );

  try {
    await dispatchCommand(parsed, {
      discordLatencyMs: message.client.ws.ping,
      discordReady: message.client.isReady(),
      lavalinkReady: lavalink.isReady(),
      play: async (input) =>
        handlePlay(message, input, music, searchViews, playerViews, registerPlayerMessage),
      control: async (invocation) => handleControl(message, invocation, music),
      presentNowPlaying: async () => {
        const view = playerViews.render(music.getSnapshot(message.guildId));
        const sent = await message.channel.send({
          content: view.content,
          components: view.components,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
        if (view.components.length > 0) {
          registerPlayerMessage(message.guildId, sent);
        }
      },
      presentQueue: async () => {
        const view = queueViews.render(music.getSnapshot(message.guildId));
        await message.channel.send({
          content: view.content,
          components: view.components,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
      },
      send: async (content) => {
        await message.channel.send({
          content: truncateMessage(content),
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
      },
    });
    await refreshPlayerMessage(message.guildId);
  } catch (error: unknown) {
    logError(logger, "command_failed", error, "Discord command failed");

    try {
      await message.channel.send({
        content: "The command could not be completed.",
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
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
      content: "This queue view is no longer active. Run `\\queue` again.",
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

async function updateInteractionAloneStatus(
  interaction: StringSelectMenuInteraction<"cached">,
  music: MusicController,
  voiceChannelId: string,
): Promise<void> {
  const identity = music.getIdentity(interaction.guildId);
  const channel = interaction.guild.channels.cache.get(voiceChannelId);
  if (
    identity !== undefined &&
    identity.voiceChannelId === voiceChannelId &&
    channel?.isVoiceBased()
  ) {
    await music.updateAloneStatus(
      identity.guildId,
      identity.playerToken,
      !hasHumanVoiceMember(channel.members.values()),
    );
  }
}

export async function handleSearchInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  music: MusicController,
  searchViews: SearchViewController,
  playerViews: NowPlayingViewController,
  registerPlayerMessage: (guildId: string, message: Message) => void,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "Search choices are available only in a loaded server.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const resolution: SearchSelectionResolution = searchViews.resolve({
    customId: interaction.customId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
  });
  if (resolution.kind === "unrelated") {
    return;
  }
  if (resolution.kind === "forbidden") {
    await interaction.reply({
      content: "Only the person who started this search can choose its result.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  if (resolution.kind === "stale") {
    await interaction.update({
      content: "This search has expired. Run `\\play` again.",
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  if (resolution.kind === "cancelled") {
    await interaction.update({
      content: "Search cancelled.",
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  if (!interaction.isStringSelectMenu()) {
    await interaction.update({
      content: "This search selection is no longer valid. Run `\\play` again.",
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const access = validateVoiceAccess(interactionVoiceFacts(interaction));
  if (access.kind !== "ready" || access.voiceChannelId !== resolution.voiceChannelId) {
    await interaction.update({
      content:
        access.kind === "ready"
          ? "Return to the voice channel where you started this search, then run `\\play` again."
          : voiceAccessMessage(access),
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(resolution.track.identifier)) {
    await interaction.update({
      content: "That search result has an invalid source identifier. Try another result.",
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  await interaction.deferUpdate();
  const result = await music.requestPlay({
    guildId: interaction.guildId,
    notificationChannelId: interaction.channelId,
    intendedVoiceChannelId: resolution.voiceChannelId,
    shardId: interaction.guild.shardId,
    input: `https://www.youtube.com/watch?v=${resolution.track.identifier}`,
    requestedBy: {
      id: interaction.user.id,
      label:
        interaction.guild.members.cache.get(interaction.user.id)?.displayName ??
        interaction.user.username,
    },
    validateCommit: () =>
      validateVoiceAccess(interactionVoiceFacts(interaction), resolution.voiceChannelId),
  });
  if (result.kind === "queued") {
    await updateInteractionAloneStatus(interaction, music, resolution.voiceChannelId);
  }

  const summary = formatPlayRequestResult(result);
  if (result.kind === "queued" && result.becameCurrent) {
    const view = playerViews.render(music.getSnapshot(interaction.guildId));
    const edited = await interaction.editReply({
      content: playerContent(view.content, result),
      components: view.components,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    if (view.components.length > 0) {
      registerPlayerMessage(interaction.guildId, edited);
    }
    return;
  }
  await interaction.editReply({
    content: summary,
    components: [],
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
}

function prepareInteractionControl(
  interaction: ButtonInteraction<"cached">,
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
  return mode === "off" ? "track" : mode === "track" ? "queue" : "off";
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
      content: "These player controls are no longer active. Run `\\nowplaying` again.",
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
      components: [],
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return;
  }

  const view = playerViews.render(music.getSnapshot(interaction.guildId));
  await interaction.editReply({
    content: view.content,
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

function voiceFacts(message: Message<true>): VoiceAccessFacts {
  return memberVoiceFacts(message.member, message.guild.members.me);
}

function interactionVoiceFacts(
  interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
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
      return "Join a voice channel before using `\\play`.";
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

function searchFailureMessage(result: Exclude<SearchTracksResult, { kind: "choices" }>): string {
  switch (result.kind) {
    case "direct-input":
      throw new Error("Direct input unexpectedly reached search failure formatting");
    case "no-match":
      return "No suitable YouTube results were found.";
    case "capacity-exhausted":
    case "queue-full":
      return "The queue is full.";
    case "unavailable":
      return "Music service is temporarily unavailable.";
    case "unsupported-url":
      return "Only YouTube and YouTube Music URLs are supported.";
    case "failure":
      return "YouTube could not search for that request. Try another song.";
    case "pending-limit":
      return "Too many play requests are already pending for this server.";
    case "stale":
      return "That search was canceled by a newer stop or disconnect.";
    case "wrong-channel":
      return "Join the bot's current voice channel before adding music.";
    case "closed":
      return "Music service is shutting down.";
  }
}

export function formatPlayRequestResult(result: PlayRequestResult): string {
  switch (result.kind) {
    case "queued": {
      const title = truncateMessage(escapeExternalText(result.firstTrack.title), 160);
      const playlistName =
        result.playlistName === null
          ? null
          : truncateMessage(escapeExternalText(result.playlistName), 120);
      let message: string;
      if (result.becameCurrent) {
        message = `Playing **${title}**`;
        if (result.addedTrackCount > 1) {
          message += ` and queued ${result.addedTrackCount - 1} more`;
        }
      } else if (result.addedTrackCount === 1) {
        message = `Queued **${title}**`;
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

function supportedCallerVoice(message: Message<true>, intendedVoiceChannelId: string): boolean {
  const channel = message.member?.voice.channel;
  return channel?.type === ChannelType.GuildVoice && channel.id === intendedVoiceChannelId;
}

function prepareControl(
  message: Message<true>,
  music: MusicController,
  allowMissingSession = false,
): PlaybackControlRequest | { readonly message: string } {
  const identity = music.getIdentity(message.guildId);
  const access = validateControlVoiceAccess(
    voiceFacts(message),
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
    guildId: message.guildId,
    intendedVoiceChannelId: access.voiceChannelId,
    playerToken: identity?.playerToken ?? null,
    validateCommit: () => supportedCallerVoice(message, access.voiceChannelId),
  };
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

function playerContent(
  viewContent: string,
  result: Extract<PlayRequestResult, { kind: "queued" }>,
): string {
  const note = formatStartedTrackNote(result);
  return note.length === 0 ? viewContent : truncateMessage(`${viewContent}\n\n${note}`);
}

async function handleControl(
  message: Message<true>,
  invocation: ExecutableControlCommandInvocation,
  music: MusicController,
): Promise<string> {
  if (invocation.name === "volume" && invocation.volume === null) {
    const snapshot = music.getSnapshot(message.guildId);
    return snapshot === undefined
      ? "There is no active music session."
      : `Current volume: ${snapshot.volume}%.`;
  }

  const prepared = prepareControl(
    message,
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
  message: Message<true>,
  input: string,
  music: MusicController,
  searchViews: SearchViewController,
  playerViews: NowPlayingViewController,
  registerPlayerMessage: (guildId: string, message: Message) => void,
): Promise<string | null> {
  const initialAccess = validateVoiceAccess(voiceFacts(message));
  if (initialAccess.kind !== "ready") {
    return voiceAccessMessage(initialAccess);
  }

  const search = await music.searchTracks({
    guildId: message.guildId,
    intendedVoiceChannelId: initialAccess.voiceChannelId,
    input,
    resultLimit: SEARCH_RESULT_LIMIT,
  });
  if (search.kind === "choices") {
    const view = searchViews.render({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      voiceChannelId: initialAccess.voiceChannelId,
      query: input,
      tracks: search.tracks,
    });
    await message.channel.send({
      content: view.content,
      components: view.components,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    return null;
  }
  if (search.kind !== "direct-input") {
    return searchFailureMessage(search);
  }

  const result = await music.requestPlay({
    guildId: message.guildId,
    notificationChannelId: message.channelId,
    intendedVoiceChannelId: initialAccess.voiceChannelId,
    shardId: message.guild?.shardId ?? 0,
    input,
    requestedBy: {
      id: message.author.id,
      label: message.member?.displayName ?? message.author.username,
    },
    validateCommit: () => validateVoiceAccess(voiceFacts(message), initialAccess.voiceChannelId),
  });
  if (result.kind === "queued") {
    const identity = music.getIdentity(message.guildId);
    const channel = message.guild?.channels.cache.get(initialAccess.voiceChannelId);
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

  const view = playerViews.render(music.getSnapshot(message.guildId));
  const sent = await message.channel.send({
    content: playerContent(view.content, result),
    components: view.components,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
  if (view.components.length > 0) {
    registerPlayerMessage(message.guildId, sent);
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
  const searchViews = createSearchViewController();
  const playerViews = createNowPlayingViewController();
  const playerMessages = new Map<string, Message>();
  let acceptingCommands = false;
  let started = false;
  let stopped = false;

  function retirePlayerMessage(guildId: string): void {
    playerMessages.delete(guildId);
  }

  function registerPlayerMessage(guildId: string, message: Message): void {
    const previous = playerMessages.get(guildId);
    if (previous === undefined && playerMessages.size >= PLAYER_MESSAGE_LIMIT) {
      const oldestGuildId = playerMessages.keys().next().value;
      if (oldestGuildId !== undefined) {
        const oldestMessage = playerMessages.get(oldestGuildId);
        playerMessages.delete(oldestGuildId);
        void oldestMessage?.edit({ components: [] }).catch(() => undefined);
      }
    }
    playerMessages.set(guildId, message);
    if (previous !== undefined && previous.id !== message.id) {
      void previous.edit({ components: [] }).catch((error: unknown) => {
        logger.debug(
          { event: "player_previous_message_retire_failed", ...errorFields(error) },
          "Could not retire a superseded player message",
        );
      });
    }
  }

  async function refreshPlayerMessage(guildId: string): Promise<void> {
    const message = playerMessages.get(guildId);
    if (message === undefined) {
      return;
    }
    const view = playerViews.render(music.getSnapshot(guildId));
    try {
      await message.edit({
        content: view.content,
        components: view.components,
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
      if (view.components.length === 0) {
        retirePlayerMessage(guildId);
      }
    } catch (error: unknown) {
      retirePlayerMessage(guildId);
      playerViews.retire(guildId);
      logger.debug(
        { event: "player_message_refresh_failed", guildId, ...errorFields(error) },
        "Could not refresh the active player message",
      );
    }
  }

  const playerRefreshTimer = setInterval(() => {
    for (const guildId of playerMessages.keys()) {
      void refreshPlayerMessage(guildId);
    }
  }, PLAYER_REFRESH_INTERVAL_MS);
  playerRefreshTimer.unref();

  function cleanupUnexpected(guildId: string): void {
    queueViews.retire(guildId);
    searchViews.retireGuild(guildId);
    playerViews.retire(guildId);
    const playerMessage = playerMessages.get(guildId);
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

  client.on(Events.MessageCreate, (message) => {
    if (acceptingCommands) {
      void handleMessage(
        message,
        logger,
        lavalink,
        music,
        queueViews,
        searchViews,
        playerViews,
        registerPlayerMessage,
        refreshPlayerMessage,
      );
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    const isSearchInteraction =
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      isSearchViewCustomId(interaction.customId);
    const isQueueInteraction = interaction.isButton() && isQueueViewCustomId(interaction.customId);
    const isPlayerInteraction =
      interaction.isButton() && isNowPlayingCustomId(interaction.customId);
    if (!isSearchInteraction && !isQueueInteraction && !isPlayerInteraction) {
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
    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      isSearchViewCustomId(interaction.customId)
    ) {
      operation = handleSearchInteraction(
        interaction,
        music,
        searchViews,
        playerViews,
        registerPlayerMessage,
      );
    } else if (interaction.isButton() && isNowPlayingCustomId(interaction.customId)) {
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
      acceptingCommands = true;

      try {
        await client.login(token);
      } catch (error: unknown) {
        acceptingCommands = false;
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
      await client.destroy();
    },
  };
}
