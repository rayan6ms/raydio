import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stopServicesInOrder } from "../src/lifecycle.js";

describe("stopServicesInOrder", () => {
  it("stops Lavalink before Discord", async () => {
    const stopped: string[] = [];

    await stopServicesInOrder([
      { stop: async () => void stopped.push("lavalink") },
      { stop: async () => void stopped.push("discord") },
    ]);

    assert.deepEqual(stopped, ["lavalink", "discord"]);
  });

  it("continues shutdown after a failure and reports the aggregate", async () => {
    const stopped: string[] = [];

    await assert.rejects(
      stopServicesInOrder([
        {
          stop: async () => {
            stopped.push("lavalink");
            throw new Error("node close failed");
          },
        },
        { stop: async () => void stopped.push("discord") },
      ]),
      AggregateError,
    );

    assert.deepEqual(stopped, ["lavalink", "discord"]);
  });
});
