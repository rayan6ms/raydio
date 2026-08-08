import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("redacts Shoukaku auth and other root secret fields", () => {
    let output = "";
    const logger = createLogger("info", {
      write(message) {
        output += message;
      },
    });

    logger.info({ auth: "node-secret", password: "password-secret" }, "redaction check");

    assert.doesNotMatch(output, /node-secret|password-secret/);
    assert.match(output, /\[REDACTED\]/);
  });
});
