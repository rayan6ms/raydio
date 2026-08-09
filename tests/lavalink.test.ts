import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { Constants, Node } from "shoukaku";

import { createDiscordClient } from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import {
  createLavalinkNode,
  createLavalinkService,
  LAVALINK_NODE_NAME,
  SHOUKAKU_OPTIONS,
} from "../src/music/lavalink.js";

const credentialFixture = ["lavalink", "credential", "fixture"].join(":");

const config = {
  host: "lavalink",
  port: 2333,
  password: credentialFixture,
  secure: false,
} as const;

describe("createLavalinkNode", () => {
  it("builds exactly one named node from typed configuration", () => {
    assert.deepEqual(createLavalinkNode(config), {
      name: LAVALINK_NODE_NAME,
      url: "lavalink:2333",
      auth: credentialFixture,
      secure: false,
    });
  });

  it("brackets an IPv6 host for Shoukaku's host-and-port URL", () => {
    assert.equal(createLavalinkNode({ ...config, host: "::1" }).url, "[::1]:2333");
  });
});

describe("createLavalinkService", () => {
  it("uses the bounded reconnect policy and tracks readiness transitions", async () => {
    const client = createDiscordClient();
    const service = createLavalinkService(client, config, createLogger("silent"));

    assert.equal(service.getStatus(), "connecting");
    assert.equal(service.isReady(), false);
    assert.equal(service.manager.options.reconnectTries, 24);
    assert.equal(service.manager.options.reconnectInterval, 5);
    assert.equal(service.manager.options.resume, true);
    assert.equal(service.manager.options.resumeTimeout, 60);
    assert.equal(service.manager.options.resumeByLibrary, false);
    assert.equal(service.manager.options.moveOnDisconnect, false);
    assert.deepEqual(SHOUKAKU_OPTIONS, {
      resume: true,
      resumeTimeout: 60,
      resumeByLibrary: false,
      reconnectTries: 24,
      reconnectInterval: 5,
      moveOnDisconnect: false,
    });

    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);
    assert.equal(service.getStatus(), "ready");
    assert.equal(service.isReady(), true);

    const node = new Node(service.manager, createLavalinkNode(config));
    node.state = Constants.State.CONNECTED;
    service.manager.nodes.set(LAVALINK_NODE_NAME, node);
    assert.equal(service.getReadyNode(), node);
    service.manager.nodes.delete(LAVALINK_NODE_NAME);

    service.manager.emit("close", LAVALINK_NODE_NAME, 1006, "connection lost");
    assert.equal(service.getStatus(), "reconnecting");
    assert.equal(service.isReady(), false);

    service.manager.emit("ready", LAVALINK_NODE_NAME, true, false);
    assert.equal(service.isReady(), true);

    service.manager.emit("error", LAVALINK_NODE_NAME, new Error("reconnect attempts exhausted"));
    assert.equal(service.getStatus(), "unavailable");
    assert.equal(service.isReady(), false);

    await service.stop();
    await service.stop();
    assert.equal(service.getStatus(), "stopped");

    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);
    assert.equal(service.getStatus(), "stopped");

    client.destroy();
  });

  it("gates readiness while a non-resumed reconnect invalidates stale sessions", async () => {
    const client = createDiscordClient();
    const service = createLavalinkService(client, config, createLogger("silent"));
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const reasons: string[] = [];
    service.onSessionInvalidated(async (reason) => {
      reasons.push(reason);
      await cleanup;
    });

    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);
    service.manager.emit("close", LAVALINK_NODE_NAME, 1006, "connection lost");
    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);

    assert.equal(service.getStatus(), "reconnecting");
    assert.equal(service.isReady(), false);
    assert.deepEqual(reasons, ["session-lost"]);

    finishCleanup?.();
    await waitForImmediate();
    assert.equal(service.getStatus(), "ready");

    await service.stop();
    client.destroy();
  });

  it("emits terminal invalidation once when Shoukaku reports duplicate exhaustion signals", async () => {
    const client = createDiscordClient();
    const service = createLavalinkService(client, config, createLogger("silent"));
    const reasons: string[] = [];
    service.onSessionInvalidated((reason) => {
      reasons.push(reason);
    });

    service.manager.emit("disconnect", LAVALINK_NODE_NAME, 2);
    service.manager.emit("error", LAVALINK_NODE_NAME, new Error("already exhausted"));
    await waitForImmediate();

    assert.deepEqual(reasons, ["unavailable"]);
    assert.equal(service.getStatus(), "unavailable");

    await service.stop();
    client.destroy();
  });

  it("cannot publish ready after shutdown races a non-resumed recovery", async () => {
    const client = createDiscordClient();
    const service = createLavalinkService(client, config, createLogger("silent"));
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    service.onSessionInvalidated(async () => cleanup);

    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);
    service.manager.emit("close", LAVALINK_NODE_NAME, 1006, "connection lost");
    service.manager.emit("ready", LAVALINK_NODE_NAME, false, false);
    assert.equal(service.getStatus(), "reconnecting");

    await service.stop();
    finishCleanup?.();
    await waitForImmediate();
    assert.equal(service.getStatus(), "stopped");

    client.destroy();
  });
});
