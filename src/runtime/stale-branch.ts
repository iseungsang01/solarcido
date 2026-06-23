/**
 * Branch freshness — compares a topic branch against a main ref and maps the
 * result to a policy-driven action.  The git runner is injectable so callers
 * and tests can stay hermetic.  Ported provider-neutral from
 * claw-rust crates/runtime/src/stale_branch.rs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs `git <args>` from `cwd`. Never throws. */
export type GitRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const GIT_TIMEOUT_MS = 2_000;

function defaultRunner(cwd: string): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How fresh a topic branch is relative to the main ref. */
export type BranchFreshness =
  | { kind: "fresh" }
  | { kind: "stale"; commitsBehind: number; missingFixes: string[] }
  | { kind: "diverged"; ahead: number; behind: number; missingFixes: string[] };

/** How to respond when a branch is found to be stale or diverged. */
export type StaleBranchPolicy =
  | "autoRebase"
  | "autoMergeForward"
  | "warnOnly"
  | "block";

/** Audit events emitted when stale-branch handling is triggered. */
export type StaleBranchEvent =
  | { kind: "branchStaleAgainstMain"; branch: string; commitsBehind: number; missingFixes: string[] }
  | { kind: "rebaseAttempted"; branch: string; result: string }
  | { kind: "mergeForwardAttempted"; branch: string; result: string };

/** The action the caller should take after applying a policy to a freshness result. */
export type StaleBranchAction =
  | { kind: "noop" }
  | { kind: "warn"; message: string }
  | { kind: "block"; message: string }
  | { kind: "rebase" }
  | { kind: "mergeForward" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check how fresh `branch` is relative to `mainRef` by counting commits ahead
 * and behind.  Uses a default git runner rooted at `cwd` (defaults to `"."`).
 */
export async function checkFreshness(
  branch: string,
  mainRef: string,
  cwd = ".",
  runner?: GitRunner,
): Promise<BranchFreshness> {
  const run = runner ?? defaultRunner(cwd);

  const behind = await revListCount(run, mainRef, branch);
  const ahead = await revListCount(run, branch, mainRef);

  if (behind === 0) return { kind: "fresh" };

  if (ahead > 0) {
    return {
      kind: "diverged",
      ahead,
      behind,
      missingFixes: await missingFixSubjects(run, mainRef, branch),
    };
  }

  return {
    kind: "stale",
    commitsBehind: behind,
    missingFixes: await missingFixSubjects(run, mainRef, branch),
  };
}

/**
 * Map a freshness result to an action according to `policy`.  Pure — no git
 * calls needed.
 */
export function applyPolicy(freshness: BranchFreshness, policy: StaleBranchPolicy): StaleBranchAction {
  if (freshness.kind === "fresh") return { kind: "noop" };

  if (freshness.kind === "stale") {
    const { commitsBehind, missingFixes } = freshness;
    switch (policy) {
      case "warnOnly":
        return {
          kind: "warn",
          message: `Branch is ${commitsBehind} commit(s) behind main. Missing fixes: ${formatMissingFixes(missingFixes)}`,
        };
      case "block":
        return {
          kind: "block",
          message: `Branch is ${commitsBehind} commit(s) behind main and must be updated before proceeding.`,
        };
      case "autoRebase":
        return { kind: "rebase" };
      case "autoMergeForward":
        return { kind: "mergeForward" };
    }
  }

  // diverged
  const { ahead, behind, missingFixes } = freshness;
  switch (policy) {
    case "warnOnly":
      return {
        kind: "warn",
        message: `Branch has diverged: ${ahead} commit(s) ahead, ${behind} commit(s) behind main. Missing fixes: ${formatMissingFixes(missingFixes)}`,
      };
    case "block":
      return {
        kind: "block",
        message: `Branch has diverged (${ahead} ahead, ${behind} behind) and must be reconciled before proceeding. Missing fixes: ${formatMissingFixes(missingFixes)}`,
      };
    case "autoRebase":
      return { kind: "rebase" };
    case "autoMergeForward":
      return { kind: "mergeForward" };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatMissingFixes(fixes: string[]): string {
  return fixes.length === 0 ? "(none)" : fixes.join("; ");
}

/** Count commits in `a` that are not in `b` (i.e. `git rev-list --count b..a`). */
async function revListCount(run: GitRunner, a: string, b: string): Promise<number> {
  const out = await run(["rev-list", "--count", `${b}..${a}`]);
  if (!out.ok) return 0;
  const n = parseInt(out.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Return commit subjects from `a` that are not in `b` (i.e. `git log --format=%s b..a`). */
async function missingFixSubjects(run: GitRunner, a: string, b: string): Promise<string[]> {
  const out = await run(["log", "--format=%s", `${b}..${a}`]);
  if (!out.ok) return [];
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
