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

function readText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function stringProperty(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
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
  it("builds a hardened bot service with external secrets and health-based ordering", () => {
    const compose = readYaml("compose.yaml");
    const services = valueAt(compose, ["services"]);
    const service = valueAt(compose, ["services", "bot"]);

    assert.ok(isRecord(services));
    assert.deepEqual(Object.keys(services).toSorted(), ["bot", "lavalink"]);
    assert.ok(isRecord(service));
    assert.deepEqual(valueAt(service, ["build"]), {
      context: ".",
      dockerfile: "Dockerfile",
    });
    assert.equal(valueAt(service, ["image"]), "raydio-bot:0.1.0");
    assert.equal(valueAt(service, ["restart"]), "unless-stopped");
    assert.equal(valueAt(service, ["stop_grace_period"]), "15s");
    assert.deepEqual(valueAt(service, ["environment"]), {
      NODE_ENV: "production",
      DISCORD_TOKEN: `\${DISCORD_TOKEN:?Set DISCORD_TOKEN in .env}`,
      LOG_LEVEL: `\${LOG_LEVEL:-info}`,
      LAVALINK_HOST: "lavalink",
      LAVALINK_PORT: "2333",
      LAVALINK_PASSWORD: `\${LAVALINK_PASSWORD:?Set LAVALINK_PASSWORD in .env}`,
      LAVALINK_SECURE: "false",
      DEFAULT_VOLUME: `\${DEFAULT_VOLUME:-70}`,
      IDLE_DISCONNECT_SECONDS: `\${IDLE_DISCONNECT_SECONDS:-120}`,
      ALONE_DISCONNECT_SECONDS: `\${ALONE_DISCONNECT_SECONDS:-120}`,
      MAX_PLAYLIST_TRACKS: `\${MAX_PLAYLIST_TRACKS:-250}`,
      MAX_QUEUE_TRACKS: `\${MAX_QUEUE_TRACKS:-1000}`,
      MAX_PENDING_PLAY_REQUESTS: `\${MAX_PENDING_PLAY_REQUESTS:-10}`,
      MAX_TRACK_DURATION_HOURS: `\${MAX_TRACK_DURATION_HOURS:-3}`,
      ALLOW_LIVESTREAMS: `\${ALLOW_LIVESTREAMS:-false}`,
    });
    assert.deepEqual(valueAt(service, ["depends_on"]), {
      lavalink: { condition: "service_healthy" },
    });
    assert.equal(valueAt(service, ["read_only"]), true);
    assert.deepEqual(valueAt(service, ["tmpfs"]), ["/tmp:size=16m,mode=1777,noexec,nosuid,nodev"]);
    assert.deepEqual(valueAt(service, ["security_opt"]), ["no-new-privileges:true"]);
    assert.deepEqual(valueAt(service, ["networks"]), ["raydio"]);
    for (const forbidden of ["command", "entrypoint", "expose", "ports", "privileged", "volumes"]) {
      assert.equal(Object.hasOwn(service, forbidden), false, `bot must not define ${forbidden}`);
    }
  });

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

describe("Bot container image", () => {
  it("uses an exact multi-stage Node 24 Debian image and a non-root exec-form runtime", () => {
    const dockerfile = readText("Dockerfile");
    const packageJson = JSON.parse(readText("package.json")) as unknown;
    const base =
      "docker.io/library/node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));

    assert.deepEqual(fromLines, [`FROM ${base} AS build`, `FROM ${base} AS runtime`]);
    assert.equal(readText(".nvmrc"), "24.19.0\n");
    assert.equal(valueAt(packageJson, ["engines", "node"]), ">=24.19.0 <25");
    assert.equal(valueAt(packageJson, ["packageManager"]), "npm@11.17.0");
    assert.equal(valueAt(packageJson, ["scripts", "build"]), "node scripts/build.mjs");
    assert.match(dockerfile, /RUN npm ci --ignore-scripts/);
    assert.match(dockerfile, /node scripts\/patch-shoukaku-reconnect\.mjs/);
    assert.match(dockerfile, /npm run build/);
    assert.match(dockerfile, /npm prune --omit=dev --ignore-scripts/);
    assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/dist \.\/dist/);
    assert.match(dockerfile, /ENV NODE_ENV=production/);
    assert.match(dockerfile, /\nUSER node\n/);
    assert.match(dockerfile, /ENTRYPOINT \[\]\n/);
    assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]\n$/);
    assert.doesNotMatch(dockerfile, /\b(?:DISCORD_TOKEN|LAVALINK_PASSWORD)\b/);
    assert.doesNotMatch(dockerfile, /^EXPOSE\b/m);

    const runtimeStage = dockerfile.split(`FROM ${base} AS runtime`)[1];
    assert.ok(runtimeStage);
    assert.doesNotMatch(runtimeStage, /COPY .*\b(?:src|scripts|tests)\b/);

    const buildConfig = JSON.parse(readText("tsconfig.build.json")) as unknown;
    assert.equal(valueAt(buildConfig, ["compilerOptions", "declaration"]), false);
    assert.equal(valueAt(buildConfig, ["compilerOptions", "declarationMap"]), false);
    assert.equal(valueAt(buildConfig, ["compilerOptions", "sourceMap"]), false);
  });

  it("keeps secrets, agent context, dependencies, and build debris outside the context", () => {
    const ignored = new Set(
      readText(".dockerignore")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    for (const required of [
      ".git/",
      ".github/",
      ".gitattributes",
      "docs/",
      "node_modules/",
      "dist/",
      "coverage/",
      "tests/",
      "README.md",
      "OPERATIONS.md",
      "LICENSE",
      ".env",
      ".env.*",
      "*.log",
    ]) {
      assert.equal(ignored.has(required), true, `.dockerignore must contain ${required}`);
    }
    for (const requiredBuildInput of [
      "Dockerfile",
      "package.json",
      "package-lock.json",
      "scripts/",
      "src/",
      "tsconfig.json",
      "tsconfig.build.json",
    ]) {
      assert.equal(
        ignored.has(requiredBuildInput),
        false,
        `.dockerignore must retain ${requiredBuildInput}`,
      );
    }
  });
});

describe("GitHub continuous integration", () => {
  it("runs the complete release gate with read-only permissions and pinned actions", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const steps = valueAt(workflow, ["jobs", "check", "steps"]);

    assert.deepEqual(valueAt(workflow, ["permissions"]), { contents: "read" });
    assert.equal(valueAt(workflow, ["jobs", "check", "runs-on"]), "ubuntu-24.04");
    assert.equal(valueAt(workflow, ["jobs", "check", "timeout-minutes"]), 10);
    assert.ok(Array.isArray(steps));

    const actions = steps
      .filter(isRecord)
      .map((step) => stringProperty(step, "uses"))
      .filter((uses): uses is string => typeof uses === "string");
    assert.equal(actions.length, 2);
    assert.deepEqual(actions, [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);

    const commands = steps
      .filter(isRecord)
      .map((step) => stringProperty(step, "run"))
      .filter((run): run is string => typeof run === "string");
    assert.deepEqual(commands, ["npm ci", "npm audit", "npm run check"]);
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
    assert.equal(valueAt(application, ["logging", "request", "includeQueryString"]), false);
    assert.equal(valueAt(application, ["logging", "request", "includePayload"]), false);
  });
});
