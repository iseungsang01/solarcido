/**
 * Read-only introspection helpers backing the `/version` and `/diff` slash
 * commands. Provider-neutral; all git access degrades cleanly when the working
 * directory is not a git repository or git is unavailable.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type VersionInfo = {
  version: string;
  commit?: string;
  node: string;
  platform: string;
};

export function getVersionInfo(): VersionInfo {
  return {
    version: readPackageVersion(),
    commit: readGitCommit(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

export function formatVersionInfo(info: VersionInfo): string {
  const lines = [`solarcido ${info.version}`];
  if (info.commit) lines.push(`commit ${info.commit}`);
  lines.push(`node ${info.node}`);
  lines.push(`platform ${info.platform}`);
  return lines.join("\n");
}

/** Render `git diff` of the working tree for `cwd`, or a clean message. */
export async function getWorkingDiff(cwd: string): Promise<string> {
  try {
    const inside = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    if (inside.stdout.trim() !== "true") {
      return "  (not a git repository)";
    }
  } catch {
    return "  (not a git repository or git unavailable)";
  }

  try {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", "diff"], {
      cwd,
      maxBuffer: 1024 * 1024 * 8,
    });
    const trimmed = stdout.replace(/\s+$/, "");
    return trimmed === "" ? "  (no unstaged changes)" : trimmed;
  } catch {
    return "  (git diff failed)";
  }
}

function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readGitCommit(): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}
