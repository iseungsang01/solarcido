import assert from "node:assert/strict";
import test from "node:test";

import {
  checkFreshness,
  applyPolicy,
} from "../dist/runtime/stale-branch.js";

// ---------------------------------------------------------------------------
// Helpers — injectable mock runner, no real git subprocess in CI
// ---------------------------------------------------------------------------

/**
 * Build a mock runner for checkFreshness.
 *
 * `behind` = commits in mainRef not in branch  (git rev-list branch..main)
 * `ahead`  = commits in branch not in mainRef  (git rev-list main..branch)
 * `subjects` = commit subjects returned by `git log --format=%s main..branch`
 *              (i.e. commits that branch has that main doesn't — the "missing
 *               fixes" from main's perspective are what main has that branch lacks,
 *               so we pass the mainRef..branch subjects separately).
 *
 * The Rust implementation calls:
 *   behind = rev_list_count(mainRef, branch)  -> git rev-list --count branch..mainRef
 *   ahead  = rev_list_count(branch, mainRef)  -> git rev-list --count mainRef..branch
 *   missing_fixes = missing_fix_subjects(mainRef, branch) -> git log --format=%s branch..mainRef
 */
function makeRunner({ behind = 0, ahead = 0, missingFixSubjects = [] } = {}) {
  return async (args) => {
    const joined = args.join(" ");

    // rev-list --count branch..mainRef  -> behind count
    if (joined.startsWith("rev-list --count") && joined.includes("..")) {
      const range = args[args.length - 1]; // "b..a"
      const [b, a] = range.split("..");
      // "a" not in "b" — if a is mainRef token, return behind; if b is mainRef, return ahead
      // We key off which side is the topic branch by checking for "branch" in the name.
      // Simpler: use the position convention from the TS impl:
      //   revListCount(run, mainRef, branch) -> args = ["rev-list","--count","branch..mainRef"]
      //   revListCount(run, branch, mainRef) -> args = ["rev-list","--count","mainRef..branch"]
      // So: if range is "branch..mainRef" => behind; "mainRef..branch" => ahead
      if (a === "mainRef") return { ok: true, stdout: `${behind}\n` };
      if (a === "branch")  return { ok: true, stdout: `${ahead}\n` };
      return { ok: true, stdout: "0\n" };
    }

    // log --format=%s branch..mainRef  -> missing fix subjects
    if (joined.startsWith("log --format=%s")) {
      return { ok: true, stdout: missingFixSubjects.join("\n") + (missingFixSubjects.length ? "\n" : "") };
    }

    return { ok: false, stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// checkFreshness
// ---------------------------------------------------------------------------

test("checkFreshness returns fresh when behind is 0", async () => {
  const runner = makeRunner({ behind: 0, ahead: 0 });
  const freshness = await checkFreshness("branch", "mainRef", ".", runner);
  assert.equal(freshness.kind, "fresh");
});

test("checkFreshness returns fresh when ahead but not behind", async () => {
  const runner = makeRunner({ behind: 0, ahead: 3 });
  const freshness = await checkFreshness("branch", "mainRef", ".", runner);
  assert.equal(freshness.kind, "fresh");
});

test("checkFreshness returns stale with correct count and missing fixes", async () => {
  const runner = makeRunner({
    behind: 2,
    ahead: 0,
    missingFixSubjects: ["fix: resolve timeout", "fix: handle null pointer"],
  });
  const freshness = await checkFreshness("branch", "mainRef", ".", runner);
  assert.equal(freshness.kind, "stale");
  if (freshness.kind === "stale") {
    assert.equal(freshness.commitsBehind, 2);
    assert.deepEqual(freshness.missingFixes, ["fix: resolve timeout", "fix: handle null pointer"]);
  }
});

test("checkFreshness returns stale with empty missing fixes list", async () => {
  const runner = makeRunner({ behind: 1, ahead: 0, missingFixSubjects: [] });
  const freshness = await checkFreshness("branch", "mainRef", ".", runner);
  assert.equal(freshness.kind, "stale");
  if (freshness.kind === "stale") {
    assert.deepEqual(freshness.missingFixes, []);
  }
});

test("checkFreshness returns diverged when both ahead and behind", async () => {
  const runner = makeRunner({
    behind: 1,
    ahead: 3,
    missingFixSubjects: ["main hotfix"],
  });
  const freshness = await checkFreshness("branch", "mainRef", ".", runner);
  assert.equal(freshness.kind, "diverged");
  if (freshness.kind === "diverged") {
    assert.equal(freshness.ahead, 3);
    assert.equal(freshness.behind, 1);
    assert.deepEqual(freshness.missingFixes, ["main hotfix"]);
  }
});

// ---------------------------------------------------------------------------
// applyPolicy — pure, no git calls
// ---------------------------------------------------------------------------

test("applyPolicy returns noop for fresh branch regardless of policy", () => {
  const freshness = { kind: "fresh" };
  for (const policy of ["warnOnly", "block", "autoRebase", "autoMergeForward"]) {
    const action = applyPolicy(freshness, policy);
    assert.equal(action.kind, "noop", `policy ${policy} should be noop for fresh branch`);
  }
});

test("applyPolicy warnOnly on stale branch returns warn with commit count and fixes", () => {
  const freshness = {
    kind: "stale",
    commitsBehind: 3,
    missingFixes: ["fix: timeout", "fix: null ptr"],
  };
  const action = applyPolicy(freshness, "warnOnly");
  assert.equal(action.kind, "warn");
  if (action.kind === "warn") {
    assert.match(action.message, /3 commit\(s\) behind/);
    assert.match(action.message, /fix: timeout/);
    assert.match(action.message, /fix: null ptr/);
  }
});

test("applyPolicy block on stale branch returns block with commit count", () => {
  const freshness = { kind: "stale", commitsBehind: 1, missingFixes: ["hotfix"] };
  const action = applyPolicy(freshness, "block");
  assert.equal(action.kind, "block");
  if (action.kind === "block") {
    assert.match(action.message, /1 commit\(s\) behind/);
  }
});

test("applyPolicy autoRebase on stale branch returns rebase", () => {
  const freshness = { kind: "stale", commitsBehind: 2, missingFixes: [] };
  const action = applyPolicy(freshness, "autoRebase");
  assert.equal(action.kind, "rebase");
});

test("applyPolicy autoMergeForward on stale branch returns mergeForward", () => {
  const freshness = { kind: "stale", commitsBehind: 2, missingFixes: [] };
  const action = applyPolicy(freshness, "autoMergeForward");
  assert.equal(action.kind, "mergeForward");
});

test("applyPolicy warnOnly on diverged branch mentions ahead and behind counts", () => {
  const freshness = {
    kind: "diverged",
    ahead: 3,
    behind: 1,
    missingFixes: ["main hotfix"],
  };
  const action = applyPolicy(freshness, "warnOnly");
  assert.equal(action.kind, "warn");
  if (action.kind === "warn") {
    assert.match(action.message, /diverged/);
    assert.match(action.message, /3 commit\(s\) ahead/);
    assert.match(action.message, /1 commit\(s\) behind/);
    assert.match(action.message, /main hotfix/);
  }
});

test("applyPolicy block on diverged branch mentions ahead and behind", () => {
  const freshness = {
    kind: "diverged",
    ahead: 2,
    behind: 4,
    missingFixes: ["critical fix"],
  };
  const action = applyPolicy(freshness, "block");
  assert.equal(action.kind, "block");
  if (action.kind === "block") {
    assert.match(action.message, /2 ahead/);
    assert.match(action.message, /4 behind/);
  }
});

test("applyPolicy autoRebase on diverged branch returns rebase", () => {
  const freshness = { kind: "diverged", ahead: 5, behind: 2, missingFixes: ["fix"] };
  const action = applyPolicy(freshness, "autoRebase");
  assert.equal(action.kind, "rebase");
});

test("applyPolicy autoMergeForward on diverged branch returns mergeForward", () => {
  const freshness = { kind: "diverged", ahead: 5, behind: 2, missingFixes: ["fix"] };
  const action = applyPolicy(freshness, "autoMergeForward");
  assert.equal(action.kind, "mergeForward");
});

test("applyPolicy formats empty missing fixes as (none) in warn message", () => {
  const freshness = { kind: "stale", commitsBehind: 1, missingFixes: [] };
  const action = applyPolicy(freshness, "warnOnly");
  assert.equal(action.kind, "warn");
  if (action.kind === "warn") {
    assert.match(action.message, /\(none\)/);
  }
});
