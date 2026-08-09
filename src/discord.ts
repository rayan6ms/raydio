import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageMentionOptions,
  PermissionFlagsBits,
} from "discord.js";
import type { Logger } from "pino";

import { dispatchCommand, parseCommand } from "./commands.js";
import type { LavalinkReadiness } from "./music/lavalink.js";
import type { MusicManager, PlayRequestResult } from "./music/manager.js";
import {
  type VoiceAccessFacts,
  type VoiceAccessResult,
  validateVoiceAccess,
} from "./music/voice.js";
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

type MusicController = Pick<MusicManager, "cleanupUnexpected" | "getSnapshot" | "requestPlay">;

function logError(logger: Logger, event: string, error: unknown, message: string): void {
  logger.error({ event, ...errorFields(error) }, message);
}

async function handleMessage(
  message: Message,
  logger: Logger,
  lavalink: LavalinkReadiness,
  music: MusicController,
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
      send: async (content) => {
        await message.channel.send({ content: truncateMessage(content) });
      },
    });
  } catch (error: unknown) {
    logError(logger, "command_failed", error, "Discord command failed");

    try {
      await message.channel.send({ content: "The command could not be completed." });
    } catch (sendError: unknown) {
      logger.warn(
        { event: "command_error_response_failed", ...errorFields(sendError) },
        "Could not send command error response",
      );
    }
  }
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
      await channel.send({ content: truncateMessage(content) });
    },
  };
}

export function createDiscordService(
  client: Client,
  logger: Logger,
  lavalink: LavalinkReadiness,
  music: MusicController,
): DiscordService {
  let acceptingCommands = false;
  let started = false;
  let stopped = false;

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
  });

  client.on(Events.MessageCreate, (message) => {
    if (acceptingCommands) {
      void handleMessage(message, logger, lavalink, music);
    }
  });

  client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
    if (newState.id !== client.user?.id) {
      return;
    }
    const snapshot = music.getSnapshot(newState.guild.id);
    if (snapshot !== undefined && newState.channelId !== snapshot.voiceChannelId) {
      void music.cleanupUnexpected(newState.guild.id).catch((error: unknown) => {
        logError(logger, "unexpected_voice_cleanup_failed", error, "Voice cleanup failed");
      });
    }
  });

  return {
    client,
    async start(token: string): Promise<void> {
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
