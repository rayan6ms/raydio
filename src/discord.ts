import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageMentionOptions,
} from "discord.js";
import type { Logger } from "pino";

import { dispatchCommand, parseCommand } from "./commands.js";
import { errorFields, truncateMessage } from "./utils.js";

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

function logError(logger: Logger, event: string, error: unknown, message: string): void {
  logger.error({ event, ...errorFields(error) }, message);
}

async function handleMessage(message: Message, logger: Logger): Promise<void> {
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

export function createDiscordService(logger: Logger): DiscordService {
  const client = new Client({
    intents: DISCORD_INTENTS,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
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
      void handleMessage(message, logger);
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
