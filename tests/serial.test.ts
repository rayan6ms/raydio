import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KeyedSerialExecutor } from "../src/music/serial.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe("KeyedSerialExecutor", () => {
  it("preserves receipt order, releases after rejection, and removes idle keys", async () => {
    const executor = new KeyedSerialExecutor<string>();
    const gate = deferred<void>();
    const events: string[] = [];

    const first = executor.run("guild", async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
      throw new Error("expected failure");
    });
    const second = executor.run("guild", () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    assert.deepEqual(events, ["first-start"]);
    assert.equal(executor.activeKeyCount, 1);

    gate.resolve();
    await assert.rejects(first, /expected failure/);
    assert.equal(await second, 2);
    await Promise.resolve();

    assert.deepEqual(events, ["first-start", "first-end", "second"]);
    assert.equal(executor.activeKeyCount, 0);
  });

  it("does not let one guild block another", async () => {
    const executor = new KeyedSerialExecutor<string>();
    const gate = deferred<void>();
    const blocked = executor.run("guild-a", () => gate.promise);

    assert.equal(await executor.run("guild-b", () => "independent"), "independent");
    await Promise.resolve();
    assert.equal(executor.activeKeyCount, 1);

    gate.resolve();
    await blocked;
  });
});
