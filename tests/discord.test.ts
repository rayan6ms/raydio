import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayIntentBits } from "discord.js";

import {
  createDiscordClient,
  createDiscordService,
  DISCORD_INTENTS,
  SAFE_ALLOWED_MENTIONS,
} from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import type { LavalinkReadiness } from "../src/music/lavalink.js";

const unavailableLavalink: LavalinkReadiness = {
  getStatus: () => "unavailable",
  isReady: () => false,
};

describe("createDiscordService", () => {
  it("uses only the required intents and disables all automatic mentions", async () => {
    const client = createDiscordClient();
    const service = createDiscordService(client, createLogger("silent"), unavailableLavalink);

    assert.deepEqual(DISCORD_INTENTS, [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ]);
    assert.deepEqual(service.client.options.intents.toArray().toSorted(), [
      "GuildMessages",
      "GuildVoiceStates",
      "Guilds",
      "MessageContent",
    ]);
    assert.deepEqual(service.client.options.allowedMentions, SAFE_ALLOWED_MENTIONS);
    assert.equal(service.client, client);

    await service.stop();
    await service.stop();
  });
});
