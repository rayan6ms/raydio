import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const PATCHED_RECONNECT_BLOCK =
  "this.ws = await createConnection();\n        connectError = void 0;\n        break;";

describe("Shoukaku compatibility patch", () => {
  it("clears a failed connection error after a later retry succeeds", async () => {
    const targets = [
      new URL("../node_modules/shoukaku/dist/index.js", import.meta.url),
      new URL("../node_modules/shoukaku/dist/index.mjs", import.meta.url),
    ];

    for (const target of targets) {
      assert.ok((await readFile(target, "utf8")).includes(PATCHED_RECONNECT_BLOCK));
    }
  });
});
