import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeRepo, detectStack, formatInitReport } from "../dist/cli/init.js";

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "solarcido-init-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("initializeRepo creates CLAUDE.md and .gitignore on a fresh repo", async () => {
  await withTempWorkspace(async (dir) => {
    const report = await initializeRepo(dir);

    assert.ok(existsSync(join(dir, "CLAUDE.md")));
    assert.ok(existsSync(join(dir, ".gitignore")));

    const byName = Object.fromEntries(report.artifacts.map((a) => [a.name, a.status]));
    assert.equal(byName["CLAUDE.md"], "created");
    assert.equal(byName[".gitignore"], "created");
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.env$/m);
  });
});

test("initializeRepo is idempotent — a second run skips existing artifacts", async () => {
  await withTempWorkspace(async (dir) => {
    await initializeRepo(dir);
    const second = await initializeRepo(dir);
    const byName = Object.fromEntries(second.artifacts.map((a) => [a.name, a.status]));
    assert.equal(byName["CLAUDE.md"], "skipped");
    assert.equal(byName[".gitignore"], "skipped");
  });
});

test("initializeRepo updates an existing .gitignore that lacks .env", async () => {
  await withTempWorkspace(async (dir) => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
    const report = await initializeRepo(dir);
    const byName = Object.fromEntries(report.artifacts.map((a) => [a.name, a.status]));
    assert.equal(byName[".gitignore"], "updated");
    const contents = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(contents, /node_modules\//);
    assert.match(contents, /^\.env$/m);
  });
});

test("detectStack identifies a TypeScript/Node project", async () => {
  await withTempWorkspace(async (dir) => {
    writeFileSync(join(dir, "package.json"), "{}", "utf8");
    writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
    const stack = await detectStack(dir);
    assert.equal(stack.node, true);
    assert.equal(stack.typescript, true);
    assert.equal(stack.rust, false);
  });
});

test("detectStack identifies a Rust project", async () => {
  await withTempWorkspace(async (dir) => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]", "utf8");
    const stack = await detectStack(dir);
    assert.equal(stack.rust, true);
    assert.equal(stack.node, false);
  });
});

test("formatInitReport renders project + artifacts + next step", () => {
  const text = formatInitReport({
    projectRoot: "/repo",
    artifacts: [
      { name: "CLAUDE.md", status: "created" },
      { name: ".gitignore", status: "skipped" },
    ],
  });
  assert.match(text, /Project\s+\/repo/);
  assert.match(text, /CLAUDE\.md\s+created/);
  assert.match(text, /\.gitignore\s+skipped/);
  assert.match(text, /Next step/);
});
