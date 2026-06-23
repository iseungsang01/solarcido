import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBaseCommit,
  resolveExpectedBase,
  readClawBaseFile,
  formatStaleBaseWarning,
} from "../dist/runtime/stale-base.js";

// ---------------------------------------------------------------------------
// Helpers — injectable mock runner, no real git subprocess in CI
// ---------------------------------------------------------------------------

/** Build a mock runner that answers `rev-parse HEAD` and `rev-parse <ref>`. */
function makeRunner({ headSha, resolveSha } = {}) {
  return async (args) => {
    const joined = args.join(" ");
    if (joined === "rev-parse HEAD") {
      if (headSha === undefined) return { ok: false, stdout: "" };
      return { ok: true, stdout: `${headSha}\n` };
    }
    if (joined.startsWith("rev-parse ")) {
      const ref = args[1];
      if (resolveSha === undefined) return { ok: false, stdout: "" };
      // Simulate successful resolve when the ref matches what resolveSha returns.
      return { ok: true, stdout: `${resolveSha}\n` };
    }
    return { ok: false, stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// checkBaseCommit
// ---------------------------------------------------------------------------

test("returns noExpectedBase when expectedBase is undefined", async () => {
  const runner = makeRunner({ headSha: "abc1234" });
  const state = await checkBaseCommit("/repo", undefined, runner);
  assert.equal(state.kind, "noExpectedBase");
});

test("returns notAGitRepo when runner cannot resolve HEAD", async () => {
  const runner = makeRunner({ headSha: undefined });
  const state = await checkBaseCommit("/repo", { kind: "flag", value: "abc1234" }, runner);
  assert.equal(state.kind, "notAGitRepo");
});

test("returns matches when HEAD equals the resolved expected sha", async () => {
  const sha = "aaabbbccc111";
  const runner = makeRunner({ headSha: sha, resolveSha: sha });
  const state = await checkBaseCommit("/repo", { kind: "flag", value: sha }, runner);
  assert.equal(state.kind, "matches");
});

test("returns diverged when HEAD differs from resolved expected sha", async () => {
  const runner = makeRunner({ headSha: "newsha111", resolveSha: "oldsha999" });
  const state = await checkBaseCommit("/repo", { kind: "flag", value: "oldsha999" }, runner);
  assert.equal(state.kind, "diverged");
  if (state.kind === "diverged") {
    assert.equal(state.expected, "oldsha999");
    assert.equal(state.actual, "newsha111");
  }
});

test("best-effort raw string match when ref cannot be resolved (prefix match)", async () => {
  // Runner returns HEAD but fails to resolve the ref.
  const runner = async (args) => {
    const joined = args.join(" ");
    if (joined === "rev-parse HEAD") return { ok: true, stdout: "abc1234fullsha\n" };
    return { ok: false, stdout: "" };
  };
  // expectedRaw is a prefix of HEAD — should count as match.
  const state = await checkBaseCommit("/repo", { kind: "flag", value: "abc1234" }, runner);
  assert.equal(state.kind, "matches");
});

test("best-effort raw string fallback returns diverged when no prefix match", async () => {
  const runner = async (args) => {
    if (args.join(" ") === "rev-parse HEAD") return { ok: true, stdout: "deadbeef\n" };
    return { ok: false, stdout: "" };
  };
  const state = await checkBaseCommit("/repo", { kind: "flag", value: "abc1234" }, runner);
  assert.equal(state.kind, "diverged");
  if (state.kind === "diverged") {
    assert.equal(state.actual, "deadbeef");
    assert.equal(state.expected, "abc1234");
  }
});

test("works with file source the same as flag source", async () => {
  const sha = "filesha999";
  const runner = makeRunner({ headSha: sha, resolveSha: sha });
  const state = await checkBaseCommit("/repo", { kind: "file", value: sha }, runner);
  assert.equal(state.kind, "matches");
});

// ---------------------------------------------------------------------------
// readClawBaseFile — tested with an in-memory fs shim (temp file)
// ---------------------------------------------------------------------------

import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempDir(fn) {
  const dir = join(tmpdir(), `stale-base-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readClawBaseFile returns trimmed hash when file exists", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".claw-base"), "abc1234def5678\n");
    const value = await readClawBaseFile(dir);
    assert.equal(value, "abc1234def5678");
  });
});

test("readClawBaseFile returns undefined when file is absent", async () => {
  await withTempDir(async (dir) => {
    const value = await readClawBaseFile(dir);
    assert.equal(value, undefined);
  });
});

test("readClawBaseFile returns undefined when file is whitespace only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".claw-base"), "   \n");
    const value = await readClawBaseFile(dir);
    assert.equal(value, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveExpectedBase
// ---------------------------------------------------------------------------

test("resolveExpectedBase prefers flag over file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".claw-base"), "from_file\n");
    const source = await resolveExpectedBase("from_flag", dir);
    assert.ok(source);
    assert.equal(source.kind, "flag");
    assert.equal(source.value, "from_flag");
  });
});

test("resolveExpectedBase falls back to file when flag is undefined", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".claw-base"), "from_file\n");
    const source = await resolveExpectedBase(undefined, dir);
    assert.ok(source);
    assert.equal(source.kind, "file");
    assert.equal(source.value, "from_file");
  });
});

test("resolveExpectedBase returns undefined when nothing available", async () => {
  await withTempDir(async (dir) => {
    const source = await resolveExpectedBase(undefined, dir);
    assert.equal(source, undefined);
  });
});

test("resolveExpectedBase treats empty string flag as absent", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".claw-base"), "fallback\n");
    const source = await resolveExpectedBase("   ", dir);
    assert.ok(source);
    assert.equal(source.kind, "file");
    assert.equal(source.value, "fallback");
  });
});

// ---------------------------------------------------------------------------
// formatStaleBaseWarning — pure
// ---------------------------------------------------------------------------

test("formatStaleBaseWarning returns message for diverged", () => {
  const warning = formatStaleBaseWarning({ kind: "diverged", expected: "abc1234", actual: "def5678" });
  assert.ok(warning);
  assert.match(warning, /abc1234/);
  assert.match(warning, /def5678/);
  assert.match(warning, /stale codebase/);
});

test("formatStaleBaseWarning returns message for notAGitRepo", () => {
  const warning = formatStaleBaseWarning({ kind: "notAGitRepo" });
  assert.ok(warning);
  assert.match(warning, /not inside a git repository/);
});

test("formatStaleBaseWarning returns undefined for matches", () => {
  assert.equal(formatStaleBaseWarning({ kind: "matches" }), undefined);
});

test("formatStaleBaseWarning returns undefined for noExpectedBase", () => {
  assert.equal(formatStaleBaseWarning({ kind: "noExpectedBase" }), undefined);
});
