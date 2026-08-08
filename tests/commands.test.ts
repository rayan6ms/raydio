import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CommandContext,
  type CommandMessageInput,
  dispatchCommand,
  parseCommand,
  resolveCommandName,
} from "../src/commands.js";

function messageInput(
  content: string,
  overrides: Partial<CommandMessageInput> = {},
): CommandMessageInput {
  return {
    authorIsBot: false,
    content,
    guildId: "guild-id",
    ...overrides,
  };
}

function context(
  sent: string[],
  overrides: Partial<Omit<CommandContext, "send">> = {},
): CommandContext {
  return {
    discordLatencyMs: 42.4,
    discordReady: true,
    lavalinkReady: true,
    ...overrides,
    send: async (content) => {
      sent.push(content);
    },
  };
}

describe("parseCommand", () => {
  it("parses the literal prefix and a free-form argument", () => {
    assert.deepEqual(parseCommand(messageInput("\\play Daft  Punk - Instant Crush")), {
      name: "play",
      argument: "Daft  Punk - Instant Crush",
    });
  });

  it("normalizes command case without changing the argument", () => {
    assert.deepEqual(parseCommand(messageInput("  \\PLAY   Song With CAPS  ")), null);
    assert.deepEqual(parseCommand(messageInput("\\PLAY   Song With CAPS  ")), {
      name: "play",
      argument: "Song With CAPS",
    });
  });

  it("parses commands without arguments", () => {
    assert.deepEqual(parseCommand(messageInput("\\skip")), {
      name: "skip",
      argument: "",
    });
    assert.deepEqual(parseCommand(messageInput("\\volume 75")), {
      name: "volume",
      argument: "75",
    });
  });

  it("strips exactly one prefix character", () => {
    assert.deepEqual(parseCommand(messageInput("\\\\play song")), {
      name: "\\play",
      argument: "song",
    });
  });

  it("ignores non-prefixed, prefix-only, bot-authored, and DM input", () => {
    assert.equal(parseCommand(messageInput("hello")), null);
    assert.equal(parseCommand(messageInput("\\")), null);
    assert.equal(parseCommand(messageInput("\\   ")), null);
    assert.equal(parseCommand(messageInput("\\ping", { authorIsBot: true })), null);
    assert.equal(parseCommand(messageInput("\\ping", { guildId: null })), null);
  });
});

describe("resolveCommandName", () => {
  it("resolves canonical names case-insensitively", () => {
    assert.equal(resolveCommandName("PLAY"), "play");
    assert.equal(resolveCommandName("nowplaying"), "nowplaying");
  });

  it("resolves every v1 alias", () => {
    assert.deepEqual(["p", "s", "q", "np", "vol", "disconnect", "dc"].map(resolveCommandName), [
      "play",
      "skip",
      "queue",
      "nowplaying",
      "volume",
      "leave",
      "leave",
    ]);
  });

  it("rejects unknown and double-prefixed names", () => {
    assert.equal(resolveCommandName("unknown"), null);
    assert.equal(resolveCommandName("\\play"), null);
  });
});

describe("dispatchCommand", () => {
  it("handles help", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "help", argument: "" }, context(sent));

    assert.equal(result, "handled");
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /\\help/);
    assert.match(sent[0] ?? "", /\\ping/);
  });

  it("reports rounded Discord latency", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "ping", argument: "" }, context(sent));

    assert.equal(result, "handled");
    assert.deepEqual(sent, ["Pong! Discord: 42 ms. Lavalink: ready."]);
  });

  it("reports unavailable latency before readiness", async () => {
    const sent: string[] = [];
    await dispatchCommand(
      { name: "ping", argument: "" },
      context(sent, { discordLatencyMs: -1, discordReady: false }),
    );

    assert.deepEqual(sent, ["Pong! Discord: unavailable. Lavalink: ready."]);
  });

  it("reports Lavalink unavailability in ping and fails music commands fast", async () => {
    const sent: string[] = [];

    await dispatchCommand({ name: "ping", argument: "" }, context(sent, { lavalinkReady: false }));
    const result = await dispatchCommand(
      { name: "p", argument: "song" },
      context(sent, { lavalinkReady: false }),
    );

    assert.equal(result, "unavailable");
    assert.deepEqual(sent, [
      "Pong! Discord: 42 ms. Lavalink: unavailable.",
      "Music service is temporarily unavailable.",
    ]);
  });

  it("does not pretend the next playback milestone is implemented when Lavalink is ready", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "p", argument: "song" }, context(sent));

    assert.equal(result, "unavailable");
    assert.deepEqual(sent, ["Music playback is not implemented yet."]);
  });

  it("responds concisely to unknown commands", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "wat", argument: "" }, context(sent));

    assert.equal(result, "unknown");
    assert.deepEqual(sent, ["Unknown command. Use `\\help` to see the command list."]);
  });
});
