import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayIntentBits } from "discord.js";

import { createDiscordService, DISCORD_INTENTS, SAFE_ALLOWED_MENTIONS } from "../src/discord.js";
import { createLogger } from "../src/logger.js";

describe("createDiscordService", () => {
  it("uses only the required intents and disables all automatic mentions", async () => {
    const service = createDiscordService(createLogger("silent"));

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

    await service.stop();
    await service.stop();
  });
});
