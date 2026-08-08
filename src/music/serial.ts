export class KeyedSerialExecutor<Key> {
  readonly #tails = new Map<Key, Promise<void>>();

  get activeKeyCount(): number {
    return this.#tails.size;
  }

  run<Result>(key: Key, task: () => Result | PromiseLike<Result>): Promise<Result> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );

    this.#tails.set(key, settled);
    void settled.then(() => {
      if (this.#tails.get(key) === settled) {
        this.#tails.delete(key);
      }
    });

    return result;
  }
}
