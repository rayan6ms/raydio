import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const outputDirectory = new URL("dist/", projectRoot);
const compiler = fileURLToPath(new URL("node_modules/typescript/bin/tsc", projectRoot));
const config = fileURLToPath(new URL("tsconfig.build.json", projectRoot));

await rm(outputDirectory, { force: true, recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [compiler, "-p", config], {
    cwd: fileURLToPath(projectRoot),
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(
      new Error(
        signal === null
          ? `TypeScript build exited with code ${String(code)}`
          : `TypeScript build was terminated by ${signal}`,
      ),
    );
  });
});
