import {
  type ButtonInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  type MessageMentionOptions,
  PermissionFlagsBits,
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
} from "./music/manager.js";
import type { GuildPlaybackIdentity, GuildPlaybackSnapshot } from "./music/state.js";
import {
  type VoiceAccessFacts,
  type VoiceAccessResult,
  validateControlVoiceAccess,
  validateVoiceAccess,
} from "./music/voice.js";
import {
  createQueueViewController,
  formatDuration,
  isQueueViewCustomId,
  type QueueViewController,
} from "./queue-view.js";
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
  | "requestPlay"
  | "setPaused"
  | "setVolume"
  | "setLoopMode"
  | "removeUpcoming"
  | "clearUpcoming"
  | "shuffleUpcoming"
  | "skip"
  | "stop"
  | "leave"
  | "updateAloneStatus"
>;

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
      play: async (input) => handlePlay(message, input, music),
      control: async (invocation) => handleControl(message, invocation, music),
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

function voiceFacts(message: Message<true>): VoiceAccessFacts {
  const channel = message.member?.voice.channel ?? null;
  const botMember = message.guild?.members.me ?? null;
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

async function handleControl(
  message: Message<true>,
  invocation: ExecutableControlCommandInvocation,
  music: MusicController,
): Promise<string> {
  if (invocation.name === "nowplaying") {
    return formatNowPlayingSnapshot(music.getSnapshot(message.guildId));
  }
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
): Promise<string> {
  const initialAccess = validateVoiceAccess(voiceFacts(message));
  if (initialAccess.kind !== "ready") {
    return voiceAccessMessage(initialAccess);
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
  return formatPlayRequestResult(result);
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
  let acceptingCommands = false;
  let started = false;
  let stopped = false;

  function cleanupUnexpected(guildId: string): void {
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

  client.on(Events.MessageCreate, (message) => {
    if (acceptingCommands) {
      void handleMessage(message, logger, lavalink, music, queueViews);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton() || !isQueueViewCustomId(interaction.customId)) {
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
          logError(logger, "queue_interaction_reply_failed", error, "Queue interaction failed");
        });
      return;
    }
    void handleQueueButtonInteraction(interaction, music, queueViews).catch((error: unknown) => {
      logError(logger, "queue_interaction_failed", error, "Queue interaction failed");
      if (!interaction.replied && !interaction.deferred) {
        void interaction
          .reply({
            content: "The queue view could not be updated.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: SAFE_ALLOWED_MENTIONS,
          })
          .catch((replyError: unknown) => {
            logError(
              logger,
              "queue_interaction_error_reply_failed",
              replyError,
              "Could not send queue interaction error response",
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
      await client.destroy();
    },
  };
}
