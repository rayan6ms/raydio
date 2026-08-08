import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorFields, escapeExternalText, truncateMessage } from "../src/utils.js";

describe("escapeExternalText", () => {
  it("escapes Discord markdown in external metadata", () => {
    const escaped = escapeExternalText(
      "# **Track** | [click](https://example.com)\n- item\n> quote\n-# subtext",
    );

    assert.match(escaped, /^\\#/);
    assert.match(escaped, /\\\*\\\*Track\\\*\\\*/);
    assert.match(escaped, /\\\[click]/);
    assert.match(escaped, /\n\\- item/);
    assert.match(escaped, /\n\\> quote/);
    assert.match(escaped, /\n\\-# subtext$/);
  });
});

describe("truncateMessage", () => {
  it("returns content at or below the limit unchanged", () => {
    assert.equal(truncateMessage("12345", 5), "12345");
    assert.equal(truncateMessage("short", 10), "short");
  });

  it("truncates with an ellipsis without splitting a surrogate pair", () => {
    const truncated = truncateMessage("1234😀xyz", 7);

    assert.equal(truncated, "1234😀…");
    assert.equal(truncated.length, 7);
  });

  it("supports a one-character limit", () => {
    assert.equal(truncateMessage("long", 1), "…");
  });

  it("rejects invalid limits", () => {
    for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(() => truncateMessage("text", limit), RangeError);
    }
  });
});

describe("errorFields", () => {
  it("normalizes Error objects without serializing the object", () => {
    assert.deepEqual(errorFields(new TypeError("bad input")), {
      errorClass: "TypeError",
      errorMessage: "bad input",
    });
  });

  it("does not stringify arbitrary thrown values", () => {
    assert.deepEqual(errorFields({ secret: "do-not-log" }), {
      errorClass: "UnknownThrownValue",
      errorMessage: "A non-Error value was thrown",
    });
  });
});
