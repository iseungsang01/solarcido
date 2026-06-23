/**
 * Git-aware context gathered once at session start for injection into the system
 * prompt. Ported provider-neutral from claw-rust crates/runtime/src/git_context.rs.
 *
 * The git runner is injectable so callers (and tests) can avoid spawning a real
 * `git` subprocess; the default runner shells out via `execFile` with a short
 * per-call timeout and treats any failure (incl. "not a git repo") as absent.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitCommitEntry = { hash: string; subject: string };

export type GitContext = {
  branch?: string;
  recentCommits: GitCommitEntry[];
  stagedFiles: string[];
};

/** Runs `git <args>` and reports success + stdout. Never throws. */
export type GitRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const MAX_RECENT_COMMITS = 5;
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

/**
 * Detect git context for `cwd`. Returns `undefined` when the directory is not a
 * git work tree or git is unavailable — detection must never block a turn.
 */
export async function detectGitContext(cwd: string, runner?: GitRunner): Promise<GitContext | undefined> {
  const run = runner ?? defaultRunner(cwd);

  const inside = await run(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return undefined;
  }

  return {
    branch: await readBranch(run),
    recentCommits: await readRecentCommits(run),
    stagedFiles: await readStagedFiles(run),
  };
}

async function readBranch(run: GitRunner): Promise<string | undefined> {
  const out = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!out.ok) return undefined;
  const branch = out.stdout.trim();
  return branch === "" || branch === "HEAD" ? undefined : branch;
}

async function readRecentCommits(run: GitRunner): Promise<GitCommitEntry[]> {
  const out = await run([
    "--no-optional-locks",
    "log",
    "--oneline",
    "-n",
    String(MAX_RECENT_COMMITS),
    "--no-decorate",
  ]);
  if (!out.ok) return [];

  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line): GitCommitEntry | undefined => {
      const idx = line.indexOf(" ");
      if (idx === -1) return undefined;
      return { hash: line.slice(0, idx), subject: line.slice(idx + 1) };
    })
    .filter((entry): entry is GitCommitEntry => entry !== undefined);
}

async function readStagedFiles(run: GitRunner): Promise<string[]> {
  const out = await run(["--no-optional-locks", "diff", "--cached", "--name-only"]);
  if (!out.ok) return [];
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Render a human-readable summary suitable for system-prompt injection. Pure. */
export function renderGitContext(context: GitContext): string {
  const lines: string[] = [];

  if (context.branch) {
    lines.push(`Git branch: ${context.branch}`);
  }

  if (context.recentCommits.length > 0) {
    lines.push("");
    lines.push("Recent commits:");
    for (const entry of context.recentCommits) {
      lines.push(`  ${entry.hash} ${entry.subject}`);
    }
  }

  if (context.stagedFiles.length > 0) {
    lines.push("");
    lines.push("Staged files:");
    for (const file of context.stagedFiles) {
      lines.push(`  ${file}`);
    }
  }

  return lines.join("\n");
}

/** Convenience: detect + render in one call, returning `undefined` when absent. */
export async function detectAndRenderGitContext(cwd: string, runner?: GitRunner): Promise<string | undefined> {
  const context = await detectGitContext(cwd, runner);
  if (!context) return undefined;
  const rendered = renderGitContext(context);
  return rendered.trim() === "" ? undefined : rendered;
}
