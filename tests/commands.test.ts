import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLICATION_COMMANDS,
  COMMAND_NAMES,
  type CommandContext,
  dispatchCommand,
  HELP_MESSAGE,
} from "../src/commands.js";

function context(sent: string[], overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    discordLatencyMs: 42.4,
    discordReady: true,
    lavalinkReady: true,
    play: async (input) => `playing:${input}`,
    control: async (invocation) => `control:${invocation.name}`,
    presentNowPlaying: async () => {
      sent.push("nowplaying");
    },
    presentQueue: async () => {
      sent.push("queue");
    },
    send: async (content) => {
      sent.push(content);
    },
    ...overrides,
  };
}

describe("application command registry", () => {
  it("registers every command once in intentional task order and only in guild installs", () => {
    const data = APPLICATION_COMMANDS.map((builder) => builder.toJSON());

    assert.deepEqual(
      data.map((item) => item.name),
      Array.from(COMMAND_NAMES),
    );
    assert.equal(new Set(data.map((item) => item.name)).size, data.length);
    for (const item of data) {
      assert.deepEqual(item.integration_types, [0]);
      assert.deepEqual(item.contexts, [0]);
    }
  });

  it("registers a required plain request option without opening autocomplete", () => {
    const play = APPLICATION_COMMANDS[0].toJSON();
    assert.equal(play.name, "play");
    const request = play.options?.[0];
    assert.equal(request?.type, 3);
    assert.equal(request?.name, "request");
    assert.equal(request?.description, "Search terms or a YouTube video or playlist URL");
    assert.equal("required" in (request ?? {}) ? request.required : undefined, true);
    assert.equal("autocomplete" in (request ?? {}) ? request.autocomplete : undefined, undefined);
  });

  it("uses slash syntax throughout the compact help menu", () => {
    assert.match(HELP_MESSAGE, /`\/play request:`/);
    assert.match(HELP_MESSAGE, /`\/move from: to:`/);
    assert.doesNotMatch(HELP_MESSAGE, /`\\/);
  });
});

describe("dispatchCommand", () => {
  it("handles help and ping", async () => {
    const sent: string[] = [];
    const testContext = context(sent);

    assert.equal(await dispatchCommand({ name: "help", argument: "" }, testContext), "handled");
    assert.equal(await dispatchCommand({ name: "ping", argument: "" }, testContext), "handled");
    assert.equal(sent[0], HELP_MESSAGE);
    assert.equal(sent[1], "Pong! Discord: 42 ms. Lavalink: ready.");
  });

  it("plays a required value and gates Lavalink-backed work", async () => {
    const sent: string[] = [];
    assert.equal(
      await dispatchCommand({ name: "play", argument: "song" }, context(sent)),
      "handled",
    );
    assert.deepEqual(sent, ["playing:song"]);

    sent.length = 0;
    assert.equal(
      await dispatchCommand(
        { name: "play", argument: "song" },
        context(sent, { lavalinkReady: false }),
      ),
      "unavailable",
    );
    assert.deepEqual(sent, ["Music service is temporarily unavailable."]);
  });

  it("converts every structured slash option into a typed control invocation", async () => {
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
      { name: "previous", argument: "" },
      { name: "skip", argument: "" },
      { name: "stop", argument: "" },
      { name: "queue", argument: "" },
      { name: "nowplaying", argument: "" },
      { name: "volume", argument: "" },
      { name: "volume", argument: "75" },
      { name: "loop", argument: "queue" },
      { name: "move", argument: "2 5" },
      { name: "jump", argument: "4" },
      { name: "shuffle", argument: "" },
      { name: "remove", argument: "3" },
      { name: "clear", argument: "" },
      { name: "leave", argument: "" },
    ];

    for (const command of commands) {
      await dispatchCommand(command, testContext);
    }

    assert.deepEqual(invocations, [
      { name: "pause" },
      { name: "resume" },
      { name: "previous" },
      { name: "skip" },
      { name: "stop" },
      { name: "volume", volume: null },
      { name: "volume", volume: 75 },
      { name: "loop", mode: "queue" },
      { name: "move", fromIndex: 2, toIndex: 5 },
      { name: "jump", displayedIndex: 4 },
      { name: "shuffle" },
      { name: "remove", displayedIndex: 3 },
      { name: "clear" },
      { name: "leave" },
    ]);
    assert.deepEqual(sent, [
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "queue",
      "nowplaying",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("rejects malformed adapter input defensively", async () => {
    const sent: string[] = [];
    const testContext = context(sent);

    for (const parsed of [
      { name: "volume", argument: "101" },
      { name: "loop", argument: "all" },
      { name: "move", argument: "1" },
      { name: "jump", argument: "0" },
      { name: "remove", argument: "-1" },
    ]) {
      await dispatchCommand(parsed, testContext);
    }
    assert.equal(sent.length, 5);
    assert.ok(sent.every((message) => message.includes("/")));
  });

  it("keeps queue views and cleanup available during a Lavalink outage", async () => {
    const sent: string[] = [];
    const invocations: unknown[] = [];
    const testContext = context(sent, {
      lavalinkReady: false,
      control: async (invocation) => {
        invocations.push(invocation);
        return "ok";
      },
    });

    await dispatchCommand({ name: "queue", argument: "" }, testContext);
    await dispatchCommand({ name: "stop", argument: "" }, testContext);
    await dispatchCommand({ name: "pause", argument: "" }, testContext);

    assert.deepEqual(invocations, [{ name: "stop" }]);
    assert.deepEqual(sent, ["queue", "ok", "Music service is temporarily unavailable."]);
  });

  it("responds safely to an obsolete command name", async () => {
    const sent: string[] = [];
    assert.equal(
      await dispatchCommand({ name: "old-command", argument: "" }, context(sent)),
      "unknown",
    );
    assert.match(sent[0] ?? "", /Type `\/`/);
  });
});
