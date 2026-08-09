import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("redacts Shoukaku auth and other root secret fields", () => {
    let output = "";
    const authFixture = ["auth", "redaction", "fixture"].join(":");
    const passwordFixture = ["password", "redaction", "fixture"].join(":");
    const logger = createLogger("info", {
      write(message) {
        output += message;
      },
    });

    logger.info({ auth: authFixture, password: passwordFixture }, "redaction check");

    assert.equal(output.includes(authFixture), false);
    assert.equal(output.includes(passwordFixture), false);
    assert.match(output, /\[REDACTED\]/);
  });
});
