/**
 * Base-commit tracking — verifies that the worktree HEAD still matches the
 * commit the session was started from.  The git runner is injectable so callers
 * and tests can stay hermetic.  Ported provider-neutral from
 * claw-rust crates/runtime/src/stale_base.rs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Where the expected base commit hash originated from. */
export type BaseCommitSource =
  | { kind: "flag"; value: string }
  | { kind: "file"; value: string };

/** Outcome of comparing worktree HEAD against the expected base commit. */
export type BaseCommitState =
  | { kind: "matches" }
  | { kind: "diverged"; expected: string; actual: string }
  | { kind: "noExpectedBase" }
  | { kind: "notAGitRepo" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the `.claw-base` file from `cwd` and return the trimmed commit hash.
 * Returns `undefined` when the file is absent or empty.
 */
export async function readClawBaseFile(cwd: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(cwd, ".claw-base"), "utf8");
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the expected base commit.  Prefers the explicit `flagValue` when
 * provided, falls back to reading `.claw-base` from `cwd`.
 */
export async function resolveExpectedBase(
  flagValue: string | undefined,
  cwd: string,
): Promise<BaseCommitSource | undefined> {
  if (flagValue !== undefined) {
    const trimmed = flagValue.trim();
    if (trimmed !== "") return { kind: "flag", value: trimmed };
  }
  const fromFile = await readClawBaseFile(cwd);
  if (fromFile !== undefined) return { kind: "file", value: fromFile };
  return undefined;
}

/**
 * Verify that the worktree HEAD matches `expectedBase`.
 *
 * Returns `{ kind: "noExpectedBase" }` when no source is supplied — the check
 * is a no-op in that case.
 */
export async function checkBaseCommit(
  cwd: string,
  expectedBase: BaseCommitSource | undefined,
  runner?: GitRunner,
): Promise<BaseCommitState> {
  if (expectedBase === undefined) return { kind: "noExpectedBase" };

  const expectedRaw = expectedBase.value;
  const run = runner ?? defaultRunner(cwd);

  const headSha = await resolveHeadSha(run);
  if (headSha === undefined) return { kind: "notAGitRepo" };

  const expectedSha = await resolveRev(run, expectedRaw);

  if (expectedSha === undefined) {
    // Cannot resolve the ref — compare raw strings as best-effort fallback.
    const matches = headSha.startsWith(expectedRaw) || expectedRaw.startsWith(headSha);
    return matches
      ? { kind: "matches" }
      : { kind: "diverged", expected: expectedRaw, actual: headSha };
  }

  return headSha === expectedSha
    ? { kind: "matches" }
    : { kind: "diverged", expected: expectedSha, actual: headSha };
}

/**
 * Format a human-readable warning when the base commit has diverged.
 * Returns `undefined` for non-warning states (`matches`, `noExpectedBase`).
 */
export function formatStaleBaseWarning(state: BaseCommitState): string | undefined {
  switch (state.kind) {
    case "diverged":
      return (
        `warning: worktree HEAD (${state.actual}) does not match expected base commit ` +
        `(${state.expected}). Session may run against a stale codebase.`
      );
    case "notAGitRepo":
      return "warning: stale-base check skipped — not inside a git repository.";
    case "matches":
    case "noExpectedBase":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveHeadSha(run: GitRunner): Promise<string | undefined> {
  return resolveRev(run, "HEAD");
}

async function resolveRev(run: GitRunner, rev: string): Promise<string | undefined> {
  const out = await run(["rev-parse", rev]);
  if (!out.ok) return undefined;
  const trimmed = out.stdout.trim();
  return trimmed === "" ? undefined : trimmed;
}
