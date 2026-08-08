import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDiscordClient } from "../src/discord.js";
import { createLogger } from "../src/logger.js";
import {
  createLavalinkNode,
  createLavalinkService,
  LAVALINK_NODE_NAME,
  SHOUKAKU_OPTIONS,
} from "../src/music/lavalink.js";

const config = {
  host: "lavalink",
  port: 2333,
  password: "test-lavalink-secret",
  secure: false,
} as const;

describe("createLavalinkNode", () => {
  it("builds exactly one named node from typed configuration", () => {
    assert.deepEqual(createLavalinkNode(config), {
      name: LAVALINK_NODE_NAME,
      url: "lavalink:2333",
      auth: "test-lavalink-secret",
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
});
