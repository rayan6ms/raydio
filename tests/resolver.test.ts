import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type LavalinkResponse, LoadType, type Track } from "shoukaku";

import { createLogger } from "../src/logger.js";
import {
  createTrackResolver,
  type ReadyNodeProvider,
  type ResolverRest,
} from "../src/music/resolver.js";

const defaultConfig = {
  allowLivestreams: false,
  maxPlaylistTracks: 3,
  maxQueueTracks: 10,
  maxTrackDurationHours: 3,
} as const;

function track(
  identifier: string,
  overrides: Partial<Track["info"]> & {
    readonly encoded?: string;
    readonly omitOptionalMetadata?: boolean;
  } = {},
): Track {
  const { encoded, omitOptionalMetadata, ...infoOverrides } = overrides;

  return {
    encoded: encoded ?? `encoded-${identifier}`,
    info: {
      identifier,
      isSeekable: true,
      author: `author-${identifier}`,
      length: 180_000,
      isStream: false,
      position: 0,
      title: `title-${identifier}`,
      ...(omitOptionalMetadata
        ? {}
        : {
            uri: `https://youtube.com/watch?v=${identifier}`,
            artworkUrl: `https://i.ytimg.com/vi/${identifier}/default.jpg`,
            isrc: `ISRC-${identifier}`,
          }),
      sourceName: "youtube",
      ...infoOverrides,
    },
    pluginInfo: { transportOnly: true },
  };
}

function search(...tracks: Track[]): LavalinkResponse {
  return { loadType: LoadType.SEARCH, data: tracks };
}

function playlist(name: string, ...tracks: Track[]): LavalinkResponse {
  return {
    loadType: LoadType.PLAYLIST,
    data: {
      encoded: "playlist-encoded-value",
      info: { name, selectedTrack: -1 },
      pluginInfo: { transportOnly: true },
      tracks,
    },
  };
}

const empty = { loadType: LoadType.EMPTY, data: {} } as const satisfies LavalinkResponse;

class FakeRest implements ResolverRest {
  readonly calls: string[] = [];
  readonly outcomes: Array<LavalinkResponse | Error | undefined>;

  constructor(...outcomes: Array<LavalinkResponse | Error | undefined>) {
    this.outcomes = outcomes;
  }

  async resolve(identifier: string): Promise<LavalinkResponse | undefined> {
    this.calls.push(identifier);
    const outcome = this.outcomes.shift();

    if (outcome instanceof Error) {
      throw outcome;
    }

    return outcome;
  }
}

function readyProvider(rest: ResolverRest): ReadyNodeProvider {
  return { getReadyNode: () => ({ rest }) };
}

describe("createTrackResolver", () => {
  it("returns unavailable without issuing REST work when no node is ready", async () => {
    const rest = new FakeRest(search(track("unused")));
    const resolver = createTrackResolver(
      { getReadyNode: () => undefined },
      defaultConfig,
      createLogger("silent"),
    );

    assert.deepEqual(await resolver.resolve("Daft Punk", 10), { kind: "unavailable" });
    assert.deepEqual(rest.calls, []);
  });

  it("rejects unsupported URLs, blank input, and full capacity before node access", async () => {
    let nodeAccesses = 0;
    const rest = new FakeRest(search(track("unused")));
    const resolver = createTrackResolver(
      {
        getReadyNode: () => {
          nodeAccesses += 1;
          return { rest };
        },
      },
      defaultConfig,
      createLogger("silent"),
    );

    assert.deepEqual(await resolver.resolve("https://example.com/audio", 10), {
      kind: "unsupported-url",
    });
    assert.deepEqual(await resolver.resolve("   ", 10), {
      kind: "no-match",
      reason: "empty",
    });
    assert.deepEqual(await resolver.resolve("song", 0), { kind: "capacity-exhausted" });
    assert.equal(nodeAccesses, 0);
    assert.deepEqual(rest.calls, []);
  });

  it("uses YouTube Music first and returns the first suitable normalized track", async () => {
    const rest = new FakeRest(search(track("music"), track("unused")));
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.resolve("Daft Punk - Instant Crush", 10);

    assert.deepEqual(rest.calls, ["ytmsearch:Daft Punk - Instant Crush"]);
    assert.equal(result.kind, "tracks");
    if (result.kind !== "tracks") {
      return;
    }

    assert.equal(result.source, "youtube-music-search");
    assert.equal(result.tracks.length, 1);
    assert.deepEqual(result.tracks[0], {
      encoded: "encoded-music",
      identifier: "music",
      title: "title-music",
      author: "author-music",
      durationMs: 180_000,
      isStream: false,
      uri: "https://youtube.com/watch?v=music",
      sourceName: "youtube",
    });
    assert.equal("pluginInfo" in (result.tracks[0] ?? {}), false);
    assert.equal(result.truncatedTrackCount, 0);
  });

  it("falls back to normal YouTube only after Music has no match", async () => {
    const rest = new FakeRest(empty, search(track("youtube")));
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.resolve("fallback song", 4);

    assert.deepEqual(rest.calls, ["ytmsearch:fallback song", "ytsearch:fallback song"]);
    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.source, "youtube-search");
      assert.equal(result.tracks[0]?.identifier, "youtube");
    }
  });

  it("skips unsuitable search candidates and falls back when all Music results are unsuitable", async () => {
    const rest = new FakeRest(
      search(
        track("stream", { isStream: true }),
        track("too-long", { length: 3 * 60 * 60 * 1_000 + 1 }),
        track("missing-encoded", { encoded: "" }),
      ),
      search(track("also-stream", { isStream: true }), track("suitable")),
    );
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.resolve("filtered song", 10);

    assert.deepEqual(rest.calls, ["ytmsearch:filtered song", "ytsearch:filtered song"]);
    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.tracks[0]?.identifier, "suitable");
      assert.equal(result.rejectedTrackCount, 1);
    }
  });

  it("passes direct YouTube URLs unchanged and does not add search prefixes", async () => {
    const directTrack = track("direct", { omitOptionalMetadata: true });
    const rest = new FakeRest({ loadType: LoadType.TRACK, data: directTrack });
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );
    const url = "https://www.youtube.com/watch?v=direct";

    const result = await resolver.resolve(url, 10);

    assert.deepEqual(rest.calls, [url]);
    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.source, "direct");
      assert.equal(result.playlistName, null);
      assert.equal(result.tracks[0]?.uri, null);
    }
  });

  it("preserves playlist order while enforcing suitability and available capacity", async () => {
    const rest = new FakeRest(
      playlist(
        "Ordered playlist",
        track("one"),
        track("stream", { isStream: true }),
        track("two"),
        track("three"),
        track("too-long", { length: 20_000_000 }),
        track("four"),
      ),
    );
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.resolve("https://youtube.com/playlist?list=ordered", 2);

    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.playlistName, "Ordered playlist");
      assert.deepEqual(
        result.tracks.map((item) => item.identifier),
        ["one", "two"],
      );
      assert.equal(result.rejectedTrackCount, 2);
      assert.equal(result.truncatedTrackCount, 2);
    }
  });

  it("enforces the playlist cap independently of remaining queue capacity", async () => {
    const rest = new FakeRest(
      playlist("Capped", track("one"), track("two"), track("three"), track("four")),
    );
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.resolve("https://youtube.com/playlist?list=capped", 10);

    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.tracks.length, 3);
      assert.equal(result.truncatedTrackCount, 1);
    }
  });

  it("accepts streams only when configured and includes the exact duration boundary", async () => {
    const rest = new FakeRest(
      search(track("stream", { isStream: true, length: 3 * 60 * 60 * 1_000 })),
    );
    const resolver = createTrackResolver(
      readyProvider(rest),
      { ...defaultConfig, allowLivestreams: true },
      createLogger("silent"),
    );

    const result = await resolver.resolve("allowed live", 1);

    assert.equal(result.kind, "tracks");
    if (result.kind === "tracks") {
      assert.equal(result.tracks[0]?.isStream, true);
      assert.equal(result.tracks[0]?.durationMs, 10_800_000);
    }
  });

  it("keeps load errors, missing responses, and thrown requests distinct without fallback", async () => {
    let logs = "";
    const logger = createLogger("trace", {
      write(message) {
        logs += message;
      },
    });
    const errorResponse = {
      loadType: LoadType.ERROR,
      data: {
        message: "sensitive-upstream-message",
        severity: "fault",
        cause: "sensitive-upstream-cause",
      },
    } as const satisfies LavalinkResponse;

    const loadErrorRest = new FakeRest(errorResponse, search(track("must-not-run")));
    const missingRest = new FakeRest(undefined, search(track("must-not-run")));
    const thrownRest = new FakeRest(new TypeError("network failed"), search(track("must-not-run")));

    assert.deepEqual(
      await createTrackResolver(readyProvider(loadErrorRest), defaultConfig, logger).resolve(
        "load error",
        10,
      ),
      { kind: "failure", reason: "load-failed" },
    );
    assert.deepEqual(
      await createTrackResolver(readyProvider(missingRest), defaultConfig, logger).resolve(
        "missing",
        10,
      ),
      { kind: "failure", reason: "invalid-response" },
    );
    assert.deepEqual(
      await createTrackResolver(readyProvider(thrownRest), defaultConfig, logger).resolve(
        "thrown",
        10,
      ),
      { kind: "failure", reason: "request-failed" },
    );

    assert.equal(loadErrorRest.calls.length, 1);
    assert.equal(missingRest.calls.length, 1);
    assert.equal(thrownRest.calls.length, 1);
    assert.doesNotMatch(logs, /sensitive-upstream-message|sensitive-upstream-cause/);
  });

  it("returns no-match when both searches are empty or unsuitable", async () => {
    const rest = new FakeRest(empty, search(track("negative", { length: -1 })));
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    assert.deepEqual(await resolver.resolve("no result", 10), {
      kind: "no-match",
      reason: "no-suitable-tracks",
    });
  });

  it("returns a bounded suitable search choice list and preserves source order", async () => {
    const rest = new FakeRest(
      search(
        track("one"),
        track("bad id"),
        track("stream", { isStream: true }),
        track("two"),
        track("three"),
        track("four"),
        track("five"),
        track("six"),
      ),
    );
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    const result = await resolver.search("ordered choices", 5);

    assert.equal(result.kind, "choices");
    if (result.kind === "choices") {
      assert.deepEqual(
        result.tracks.map((item) => item.identifier),
        ["one", "two", "three", "four", "five"],
      );
      assert.equal(result.rejectedTrackCount, 2);
    }
    assert.deepEqual(rest.calls, ["ytmsearch:ordered choices"]);
  });

  it("keeps direct URLs immediate and falls back for an empty Music choice search", async () => {
    const directResolver = createTrackResolver(
      readyProvider(new FakeRest()),
      defaultConfig,
      createLogger("silent"),
    );
    assert.deepEqual(await directResolver.search("https://youtube.com/watch?v=direct", 5), {
      kind: "direct-input",
    });

    const rest = new FakeRest(empty, search(track("fallback")));
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );
    const result = await resolver.search("fallback choices", 5);
    assert.equal(result.kind, "choices");
    if (result.kind === "choices") {
      assert.equal(result.source, "youtube-search");
      assert.equal(result.tracks[0]?.identifier, "fallback");
    }
    assert.deepEqual(rest.calls, ["ytmsearch:fallback choices", "ytsearch:fallback choices"]);
  });

  it("rejects invalid capacity and unsafe configuration as programmer errors", async () => {
    const rest = new FakeRest(search(track("unused")));
    const resolver = createTrackResolver(
      readyProvider(rest),
      defaultConfig,
      createLogger("silent"),
    );

    for (const capacity of [-1, 11, 1.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(resolver.resolve("song", capacity), RangeError);
    }
    for (const limit of [0, 11, 1.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(resolver.search("song", limit), RangeError);
    }
    assert.deepEqual(rest.calls, []);

    assert.throws(
      () =>
        createTrackResolver(
          readyProvider(rest),
          { ...defaultConfig, maxTrackDurationHours: Number.MAX_SAFE_INTEGER },
          createLogger("silent"),
        ),
      RangeError,
    );
  });
});
