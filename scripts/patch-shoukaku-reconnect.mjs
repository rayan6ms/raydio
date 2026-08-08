import { readFile, writeFile } from "node:fs/promises";

const packageUrl = new URL("../node_modules/shoukaku/package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));

if (packageJson.version !== "4.3.0") {
  throw new Error(
    `Refusing to patch Shoukaku ${String(packageJson.version)}; reassess the reconnect fix first.`,
  );
}

const original = "this.ws = await createConnection();\n        break;";
const patched =
  "this.ws = await createConnection();\n        connectError = void 0;\n        break;";
const targets = [
  new URL("../node_modules/shoukaku/dist/index.js", import.meta.url),
  new URL("../node_modules/shoukaku/dist/index.mjs", import.meta.url),
];

for (const target of targets) {
  const source = await readFile(target, "utf8");

  if (source.includes(patched)) {
    continue;
  }

  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one unpatched reconnect block in ${target.pathname}`);
  }

  await writeFile(target, source.replace(original, patched));
}
