import assert from "node:assert/strict";
import test from "node:test";

import {
  detectGitContext,
  detectAndRenderGitContext,
  renderGitContext,
} from "../dist/runtime/git-context.js";

// A mock git runner — no real `git` subprocess is spawned in CI.
function repoRunner() {
  return async (args) => {
    const a = args.join(" ");
    if (a === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n" };
    if (a === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "feat/port\n" };
    if (a.startsWith("--no-optional-locks log")) return { ok: true, stdout: "abc1234 add feature\ndef5678 fix bug\n" };
    if (a.startsWith("--no-optional-locks diff --cached")) return { ok: true, stdout: "src/main.ts\nsrc/util.ts\n" };
    return { ok: false, stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// renderGitContext (pure)
// ---------------------------------------------------------------------------

test("renderGitContext formats branch, commits, and staged files", () => {
  const rendered = renderGitContext({
    branch: "feat/test",
    recentCommits: [
      { hash: "abc1234", subject: "add feature" },
      { hash: "def5678", subject: "fix bug" },
    ],
    stagedFiles: ["src/main.ts"],
  });
  assert.match(rendered, /Git branch: feat\/test/);
  assert.match(rendered, /abc1234 add feature/);
  assert.match(rendered, /def5678 fix bug/);
  assert.match(rendered, /Recent commits:/);
  assert.match(rendered, /Staged files:/);
  assert.match(rendered, /src\/main\.ts/);
});

test("renderGitContext omits empty sections", () => {
  const rendered = renderGitContext({ branch: "main", recentCommits: [], stagedFiles: [] });
  assert.match(rendered, /Git branch: main/);
  assert.ok(!rendered.includes("Recent commits:"));
  assert.ok(!rendered.includes("Staged files:"));
});

test("renderGitContext of an empty context is the empty string", () => {
  assert.equal(renderGitContext({ recentCommits: [], stagedFiles: [] }), "");
});

// ---------------------------------------------------------------------------
// detectGitContext (injected mock runner)
// ---------------------------------------------------------------------------

test("detectGitContext parses branch, commits, and staged files", async () => {
  const ctx = await detectGitContext("/repo", repoRunner());
  assert.ok(ctx);
  assert.equal(ctx.branch, "feat/port");
  assert.deepEqual(ctx.recentCommits, [
    { hash: "abc1234", subject: "add feature" },
    { hash: "def5678", subject: "fix bug" },
  ]);
  assert.deepEqual(ctx.stagedFiles, ["src/main.ts", "src/util.ts"]);
});

test("detectGitContext returns undefined when not a git repo", async () => {
  const runner = async () => ({ ok: false, stdout: "" });
  assert.equal(await detectGitContext("/tmp/not-a-repo", runner), undefined);
});

test("detectGitContext returns undefined when inside-work-tree is false", async () => {
  const runner = async (args) =>
    args.join(" ") === "rev-parse --is-inside-work-tree"
      ? { ok: true, stdout: "false\n" }
      : { ok: false, stdout: "" };
  assert.equal(await detectGitContext("/repo/.git", runner), undefined);
});

test("detectGitContext treats detached HEAD as no branch", async () => {
  const runner = async (args) => {
    const a = args.join(" ");
    if (a === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n" };
    if (a === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "HEAD\n" };
    return { ok: false, stdout: "" };
  };
  const ctx = await detectGitContext("/repo", runner);
  assert.ok(ctx);
  assert.equal(ctx.branch, undefined);
});

// ---------------------------------------------------------------------------
// detectAndRenderGitContext
// ---------------------------------------------------------------------------

test("detectAndRenderGitContext renders a repo and returns undefined for non-repo", async () => {
  const rendered = await detectAndRenderGitContext("/repo", repoRunner());
  assert.ok(rendered);
  assert.match(rendered, /Git branch: feat\/port/);

  const none = await detectAndRenderGitContext("/tmp/x", async () => ({ ok: false, stdout: "" }));
  assert.equal(none, undefined);
});
