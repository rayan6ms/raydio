import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { COMMAND_NAMES } from "../src/commands.js";

interface PackageMetadata {
  readonly devDependencies?: {
    readonly typescript?: string;
  };
  readonly license?: string;
  readonly scripts?: {
    readonly dev?: string;
    readonly start?: string;
  };
}

function readText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function environmentExample(): ReadonlyMap<string, string> {
  const entries = readText(".env.example")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line): readonly [string, string] => {
      const separator = line.indexOf("=");
      assert.notEqual(separator, -1, `.env.example line must contain =: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    });

  return new Map(entries);
}

function documentedDefaults(readme: string): ReadonlyMap<string, string> {
  const rows = readme.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \| (?:`([^`]*)`|(required)) \|/gm);
  return new Map(Array.from(rows, (match) => [match[1] ?? "", match[2] ?? match[3] ?? ""]));
}

describe("public documentation", () => {
  it("uses the repository icon and retains a portal-compatible PNG", () => {
    const readme = readText("README.md");
    const png = readFileSync(new URL("../icons/raydio.png", import.meta.url));

    assert.match(readme, /<img src="icons\/raydio\.png"/);
    assert.match(readme, /upload `icons\/raydio\.png` as the application icon/);
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("lists every registered slash command", () => {
    const readme = readText("README.md");
    const commandSection = readme.split("## Commands\n")[1]?.split("## Configuration reference")[0];

    assert.ok(commandSection, "README must contain a commands section");
    const rows = commandSection.matchAll(/^\| `\/([a-z]+)(?: [^`]*)?` \|/gm);
    const documentedCommands: string[] = [];

    for (const row of rows) {
      documentedCommands.push(row[1] ?? "");
    }

    assert.deepEqual(documentedCommands.toSorted(), Array.from(COMMAND_NAMES).toSorted());
  });

  it("documents every example environment value and keeps secrets empty", () => {
    const example = environmentExample();
    const defaults = documentedDefaults(readText("README.md"));

    assert.equal(example.get("DISCORD_TOKEN"), "");
    assert.equal(example.get("LAVALINK_PASSWORD"), "");
    assert.equal(defaults.get("DISCORD_TOKEN"), "required");
    assert.equal(defaults.get("LAVALINK_PASSWORD"), "required");

    for (const [name, value] of example) {
      assert.ok(defaults.has(name), `README must document ${name}`);
      if (value !== "") {
        assert.equal(defaults.get(name), value, `README default must match ${name}`);
      }
    }
  });

  it("keeps the Compose and example environment surfaces aligned", () => {
    const compose = parse(readText("compose.yaml")) as {
      services?: { bot?: { environment?: Record<string, unknown> } };
    };
    const composeNames = Object.keys(compose.services?.bot?.environment ?? {}).filter(
      (name) => name !== "NODE_ENV",
    );
    const exampleNames = Array.from(environmentExample().keys());

    assert.deepEqual(composeNames.toSorted(), exampleNames.toSorted());
  });

  it("states the least-privilege deployment and unsupported-feature boundaries", () => {
    const readme = readText("README.md");
    const operations = readText("OPERATIONS.md");
    const publicDocs = `${readme}\n${operations}`;

    for (const permission of ["View Channels", "Send Messages", "Connect", "Speak"]) {
      assert.match(readme, new RegExp(`- ${permission}\\n`));
    }
    assert.match(readme, /Do not grant Administrator\./);
    assert.match(readme, /native slash commands/i);
    assert.match(readme, /no database/i);
    assert.match(readme, /regular server text channels/i);
    assert.match(operations, /Do not add ingress rules for 2333/);
    assert.match(operations, /first-deployment checks/i);
    assert.doesNotMatch(publicDocs, /(?:^|\/)docs\//i);
    assert.doesNotMatch(publicDocs, /DISCORD_TOKEN=[^\s`]+/);
    assert.doesNotMatch(publicDocs, /LAVALINK_PASSWORD=[^\s`]+/);
  });

  it("ships the MIT license consistently", () => {
    const readme = readText("README.md");
    const license = readText("LICENSE");
    const packageMetadata = JSON.parse(readText("package.json")) as PackageMetadata;

    assert.equal(packageMetadata.license, "MIT");
    assert.match(license, /^MIT License\n/);
    assert.match(license, /Copyright \(c\) 2026 rayan6ms/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(readme, /\[MIT License\]\(LICENSE\)/);
  });

  it("loads the ignored local environment in development scripts", () => {
    const packageMetadata = JSON.parse(readText("package.json")) as PackageMetadata;

    assert.match(packageMetadata.scripts?.dev ?? "", /--env-file-if-exists=\.env/);
    assert.match(packageMetadata.scripts?.start ?? "", /--env-file-if-exists=\.env/);
  });

  it("documents a safe unattended Windows migration path", () => {
    const readme = readText("README.md");
    const installer = readText("scripts/windows/install-raydio.ps1");
    const manager = readText("scripts/windows/raydio.ps1");

    assert.match(readme, /-EnvironmentFile/);
    assert.match(readme, /%LOCALAPPDATA%\\Raydio\\app/);
    assert.match(installer, /\[string\]\$EnvironmentFile/);
    assert.match(
      installer,
      /Copy-Item -LiteralPath \$EnvironmentFile -Destination \$environmentPath/,
    );
    assert.ok(
      installer.indexOf("Confirm the Fedora deployment is stopped") <
        installer.lastIndexOf("Register-StartupTask"),
      "the old host confirmation must precede automatic Windows startup registration",
    );
    for (const action of ["start", "restart", "stop", "update", "status", "logs", "doctor"]) {
      assert.match(manager, new RegExp(`"${action}"`));
    }
  });

  it("keeps the compiler on an exact TypeScript 7 release", () => {
    const packageMetadata = JSON.parse(readText("package.json")) as PackageMetadata;

    assert.match(packageMetadata.devDependencies?.typescript ?? "", /^7\.\d+\.\d+$/);
  });
});
