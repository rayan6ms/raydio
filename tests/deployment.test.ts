import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseDocument } from "yaml";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): unknown {
  const content = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const document = parseDocument(content);

  assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join("\n"));

  const parsed: unknown = document.toJS();
  return parsed;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root;

  for (const segment of path) {
    assert.ok(isRecord(current), `Expected ${path.join(".")} to traverse an object`);
    assert.ok(Object.hasOwn(current, segment), `Missing required key ${path.join(".")}`);
    current = current[segment];
  }

  return current;
}

describe("Compose configuration", () => {
  it("pins a private, authenticated Lavalink service without a host port", () => {
    const compose = readYaml("compose.yaml");
    const service = valueAt(compose, ["services", "lavalink"]);

    assert.ok(isRecord(service));
    assert.equal(
      valueAt(service, ["image"]),
      "ghcr.io/lavalink-devs/lavalink:4.2.2-alpine@sha256:96be2be7ee50d35a9bd42c8c7b99e2a4b741f09123066c1ebb9e014dd7db204d",
    );
    assert.equal(valueAt(service, ["restart"]), "unless-stopped");
    assert.equal(Object.hasOwn(service, "ports"), false);
    assert.deepEqual(valueAt(service, ["expose"]), ["2333"]);
    assert.deepEqual(valueAt(service, ["networks"]), ["raydio"]);
    assert.equal(
      valueAt(service, ["environment", "LAVALINK_SERVER_PASSWORD"]),
      `\${LAVALINK_PASSWORD:?Set LAVALINK_PASSWORD in .env}`,
    );
    assert.deepEqual(valueAt(service, ["volumes"]), [
      "./lavalink/application.yml:/opt/Lavalink/application.yml:ro",
    ]);
    assert.deepEqual(valueAt(service, ["healthcheck"]), {
      test: [
        "CMD-SHELL",
        'wget --quiet --spider -T 3 --header="Authorization: $${LAVALINK_SERVER_PASSWORD}" http://127.0.0.1:2333/version',
      ],
      interval: "15s",
      timeout: "5s",
      retries: 5,
      start_period: "15s",
    });
    assert.equal(valueAt(compose, ["networks", "raydio", "driver"]), "bridge");
  });
});

describe("Lavalink configuration", () => {
  it("loads exactly one stable youtube-source plugin with the selected clients", () => {
    const application = readYaml("lavalink/application.yml");

    assert.deepEqual(valueAt(application, ["lavalink", "plugins"]), [
      {
        dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2",
        snapshot: false,
      },
    ]);
    assert.deepEqual(valueAt(application, ["plugins", "youtube"]), {
      enabled: true,
      allowSearch: true,
      allowDirectVideoIds: false,
      allowDirectPlaylistIds: false,
      clients: ["MUSIC", "ANDROID_VR", "WEB", "WEBEMBEDDED"],
    });
  });

  it("requires environment authentication and disables every unused source", () => {
    const application = readYaml("lavalink/application.yml");

    assert.equal(
      valueAt(application, ["lavalink", "server", "password"]),
      `\${LAVALINK_SERVER_PASSWORD}`,
    );
    assert.deepEqual(valueAt(application, ["lavalink", "server", "sources"]), {
      youtube: false,
      bandcamp: false,
      soundcloud: false,
      twitch: false,
      vimeo: false,
      nico: false,
      http: false,
      local: false,
    });
    assert.equal(valueAt(application, ["lavalink", "server", "youtubePlaylistLoadLimit"]), 3);
    assert.equal(valueAt(application, ["lavalink", "server", "youtubeSearchEnabled"]), true);
    assert.equal(valueAt(application, ["lavalink", "server", "soundcloudSearchEnabled"]), false);
  });

  it("keeps only volume filtering enabled and avoids sensitive request payload logs", () => {
    const application = readYaml("lavalink/application.yml");

    assert.deepEqual(valueAt(application, ["lavalink", "server", "filters"]), {
      volume: true,
      equalizer: false,
      karaoke: false,
      timescale: false,
      tremolo: false,
      vibrato: false,
      distortion: false,
      rotation: false,
      channelMix: false,
      lowPass: false,
    });
    assert.equal(valueAt(application, ["logging", "request", "includeHeaders"]), false);
    assert.equal(valueAt(application, ["logging", "request", "includePayload"]), false);
  });
});
