#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(root, "dist", "index.js");

if (!existsSync(entrypoint)) {
  console.error("solarcido: dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: false,
});

if (result.error) {
  console.error(`solarcido: failed to launch CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
