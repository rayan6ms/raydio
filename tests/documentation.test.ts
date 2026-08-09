import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { COMMAND_ALIASES, COMMAND_NAMES } from "../src/commands.js";

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
  it("lists every executable command and alias using the literal prefix", () => {
    const readme = readText("README.md");
    const commandSection = readme.split("## Commands\n")[1]?.split("## Configuration reference")[0];

    assert.ok(commandSection, "README must contain a commands section");
    const rows = commandSection.matchAll(/^\| `\\([a-z]+)(?: [^`]*)?` \| ([^|]+) \|/gm);
    const documentedCommands: string[] = [];
    const documentedAliases: string[] = [];

    for (const row of rows) {
      documentedCommands.push(row[1] ?? "");
      const aliasCell = row[2] ?? "";
      documentedAliases.push(
        ...Array.from(aliasCell.matchAll(/`\\([a-z]+)`/g), (match) => match[1] ?? ""),
      );
    }

    assert.deepEqual(documentedCommands.toSorted(), Array.from(COMMAND_NAMES).toSorted());
    assert.deepEqual(
      documentedAliases.toSorted(),
      COMMAND_ALIASES.map(([alias]) => alias).toSorted(),
    );
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
    assert.match(readme, /no slash commands/i);
    assert.match(readme, /no database/i);
    assert.match(operations, /Do not add ingress rules for 2333/);
    assert.match(operations, /first-deployment checks/i);
    assert.doesNotMatch(publicDocs, /(?:^|\/)docs\//i);
    assert.doesNotMatch(publicDocs, /DISCORD_TOKEN=[^\s`]+/);
    assert.doesNotMatch(publicDocs, /LAVALINK_PASSWORD=[^\s`]+/);
  });
});
