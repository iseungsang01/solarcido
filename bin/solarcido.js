#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeName = process.platform === "win32" ? "solarcido.exe" : "solarcido";
const candidates = [
  path.join(root, "target", "release", exeName),
  path.join(root, "target", "debug", exeName),
];
const targetRoot = path.join(root, "target");
if (existsSync(targetRoot)) {
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    candidates.push(path.join(targetRoot, entry.name, "release", exeName));
    candidates.push(path.join(targetRoot, entry.name, "debug", exeName));
  }
}

const binary = candidates.find((candidate) => existsSync(candidate));
const command = binary ?? "cargo";
const args = binary
  ? process.argv.slice(2)
  : ["run", "-p", "solarcido-cli", "--", ...process.argv.slice(2)];

const result = spawnSync(command, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: false,
});

if (result.error) {
  console.error(`solarcido: failed to launch Rust CLI: ${result.error.message}`);
  if (!binary) {
    console.error("solarcido: install Rust/Cargo or run `npm run build:rust`.");
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
