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
    play: async (input) => `playing:${input}`,
    control: async (invocation) => `control:${invocation.name}`,
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

  it("dispatches play aliases with the preserved argument", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "p", argument: "song" }, context(sent));

    assert.equal(result, "handled");
    assert.deepEqual(sent, ["playing:song"]);
  });

  it("shows play usage without invoking playback when the argument is empty", async () => {
    const sent: string[] = [];
    let playCalls = 0;
    const result = await dispatchCommand(
      { name: "play", argument: "" },
      context(sent, {
        play: async () => {
          playCalls += 1;
          return "unused";
        },
      }),
    );

    assert.equal(result, "handled");
    assert.equal(playCalls, 0);
    assert.deepEqual(sent, ["Usage: `\\play <song or YouTube URL>`."]);
  });

  it("parses and dispatches every control with typed strict arguments", async () => {
    const sent: string[] = [];
    const invocations: unknown[] = [];
    const testContext = context(sent, {
      control: async (invocation) => {
        invocations.push(invocation);
        return "ok";
      },
    });
    const commands = [
      { name: "pause", argument: "" },
      { name: "resume", argument: "" },
      { name: "s", argument: "" },
      { name: "stop", argument: "" },
      { name: "q", argument: "" },
      { name: "np", argument: "" },
      { name: "vol", argument: "" },
      { name: "volume", argument: "0" },
      { name: "volume", argument: "100" },
      { name: "loop", argument: "QUEUE" },
      { name: "shuffle", argument: "" },
      { name: "remove", argument: "12" },
      { name: "clear", argument: "" },
      { name: "dc", argument: "" },
    ];

    for (const parsed of commands) {
      assert.equal(await dispatchCommand(parsed, testContext), "handled");
    }

    assert.deepEqual(invocations, [
      { name: "pause" },
      { name: "resume" },
      { name: "skip" },
      { name: "stop" },
      { name: "queue" },
      { name: "nowplaying" },
      { name: "volume", volume: null },
      { name: "volume", volume: 0 },
      { name: "volume", volume: 100 },
      { name: "loop", mode: "queue" },
      { name: "shuffle" },
      { name: "remove", displayedIndex: 12 },
      { name: "clear" },
      { name: "leave" },
    ]);
    assert.deepEqual(
      sent,
      Array.from({ length: commands.length }, () => "ok"),
    );
  });

  it("rejects malformed control arguments before invoking the adapter", async () => {
    const sent: string[] = [];
    let calls = 0;
    const testContext = context(sent, {
      control: async () => {
        calls += 1;
        return "unused";
      },
    });
    for (const parsed of [
      { name: "pause", argument: "now" },
      { name: "volume", argument: "-1" },
      { name: "volume", argument: "101" },
      { name: "volume", argument: "1.5" },
      { name: "loop", argument: "all" },
      { name: "remove", argument: "0" },
      { name: "remove", argument: "9007199254740992" },
    ]) {
      assert.equal(await dispatchCommand(parsed, testContext), "handled");
    }
    assert.equal(calls, 0);
    assert.equal(
      sent.every((message) => message.startsWith("Usage:")),
      true,
    );
  });

  it("gates remote player controls but keeps local views and cleanup available during outages", async () => {
    const sent: string[] = [];
    const invocations: string[] = [];
    const testContext = context(sent, {
      lavalinkReady: false,
      control: async (invocation) => {
        invocations.push(invocation.name);
        return `local:${invocation.name}`;
      },
    });

    assert.equal(
      await dispatchCommand({ name: "pause", argument: "" }, testContext),
      "unavailable",
    );
    assert.equal(
      await dispatchCommand({ name: "volume", argument: "50" }, testContext),
      "unavailable",
    );
    for (const parsed of [
      { name: "volume", argument: "" },
      { name: "queue", argument: "" },
      { name: "stop", argument: "" },
      { name: "leave", argument: "" },
    ]) {
      assert.equal(await dispatchCommand(parsed, testContext), "handled");
    }
    assert.deepEqual(invocations, ["volume", "queue", "stop", "leave"]);
  });

  it("responds concisely to unknown commands", async () => {
    const sent: string[] = [];
    const result = await dispatchCommand({ name: "wat", argument: "" }, context(sent));

    assert.equal(result, "unknown");
    assert.deepEqual(sent, ["Unknown command. Use `\\help` to see the command list."]);
  });
});
