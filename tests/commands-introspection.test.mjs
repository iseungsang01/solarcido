import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatVersionInfo, getVersionInfo, getWorkingDiff } from "../dist/commands/introspection.js";

test("formatVersionInfo renders version, commit, node, platform", () => {
  const out = formatVersionInfo({
    version: "1.2.3",
    commit: "abc1234",
    node: "v20.0.0",
    platform: "linux-x64",
  });
  assert.match(out, /^solarcido 1\.2\.3$/m);
  assert.match(out, /commit abc1234/);
  assert.match(out, /node v20\.0\.0/);
  assert.match(out, /platform linux-x64/);
});

test("formatVersionInfo omits the commit line when commit is absent", () => {
  const out = formatVersionInfo({ version: "1.2.3", node: "v20", platform: "linux-x64" });
  assert.ok(!out.includes("commit "));
  assert.match(out, /^solarcido 1\.2\.3$/m);
});

test("getVersionInfo reads a semver-shaped version from package.json", () => {
  const info = getVersionInfo();
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof info.node, "string");
  assert.ok(info.platform.includes("-"));
});

test("getWorkingDiff returns a clean message outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solarcido-nogit-"));
  try {
    const diff = await getWorkingDiff(dir);
    assert.match(diff, /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
