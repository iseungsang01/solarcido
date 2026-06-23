// Bash command validation — classifies and validates shell commands before execution.
// Ported from claw-rust/crates/runtime/src/bash_validation.rs (high-value subset).

/** Semantic classification of a bash command's intent. */
export type CommandIntent =
  | "read-only"
  | "destructive"
  | "network"
  | "package-mgmt"
  | "other";

/** Result of validating a bash command before execution. */
export type ValidationResult =
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "warn"; message: string };

// ---------------------------------------------------------------------------
// Intent classification tables
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "sort", "uniq",
  "grep", "egrep", "fgrep", "find", "which", "whereis", "file", "stat",
  "du", "df", "free", "uptime", "uname", "hostname", "whoami", "id",
  "env", "printenv", "echo", "printf", "date", "pwd", "tree",
  "diff", "cmp", "md5sum", "sha256sum", "sha1sum", "xxd", "od",
  "strings", "readlink", "realpath", "basename", "dirname", "seq",
  "column", "jq", "yq", "xargs", "tr", "cut", "paste", "awk",
]);

const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "shred", "wipefs", "mkfs",
]);

// Commands that delete or overwrite (destructive subset that gets a warn not block in non-readOnly)
const DESTRUCTIVE_PATTERNS: ReadonlyArray<[string, string]> = [
  ["rm -rf /",  "Recursive forced deletion at root — this will destroy the system"],
  ["rm -rf ~",  "Recursive forced deletion of home directory"],
  ["rm -rf *",  "Recursive forced deletion of all files in current directory"],
  ["rm -rf .",  "Recursive forced deletion of current directory"],
  ["> /dev/sd", "Writing to raw disk device"],
  [":(){ :|:& };:", "Fork bomb — will crash the system"],
];

const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl", "wget", "ssh", "scp", "rsync", "ftp", "sftp",
  "nc", "ncat", "telnet", "ping", "traceroute", "dig", "nslookup", "host",
]);

const PACKAGE_MGMT_COMMANDS: ReadonlySet<string> = new Set([
  "apt", "apt-get", "yum", "dnf", "pacman", "brew",
  "pip", "pip3", "npm", "yarn", "pnpm", "bun",
  "cargo", "gem", "go", "rustup", "snap", "flatpak",
]);

/** Filesystem-write commands blocked in read-only mode. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "cp", "mv", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
  "install", "tee", "truncate", "mkfifo", "mknod", "dd",
]);

/** Git subcommands that are read-only safe. */
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "tag", "stash", "remote",
  "fetch", "ls-files", "ls-tree", "cat-file", "rev-parse", "describe",
  "shortlog", "blame", "bisect", "reflog", "config",
]);

/** System paths that indicate writes outside the workspace. */
const SYSTEM_PATHS = [
  "/etc/", "/usr/", "/var/", "/boot/", "/sys/",
  "/proc/", "/dev/", "/sbin/", "/lib/", "/opt/",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first bare command token, skipping leading KEY=val assignments. */
function extractFirstCommand(command: string): string {
  let remaining = command.trim();

  // Skip leading env var assignments: KEY=val or KEY="val"
  const envVarRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
  let m: RegExpExecArray | null;
  while ((m = envVarRe.exec(remaining)) !== null) {
    remaining = remaining.slice(m[0].length);
  }

  return remaining.split(/\s+/)[0] ?? "";
}

/** Given "git <args>", return the subcommand (first non-flag arg after "git"). */
function gitSubcommand(command: string): string | undefined {
  const parts = command.trim().split(/\s+/);
  return parts.slice(1).find((p) => !p.startsWith("-"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the semantic intent of a bash command.
 *
 * Covers: read-only, destructive, network, package-mgmt, other.
 * sed -i is treated as "other" (write) rather than read-only.
 */
export function classifyCommandIntent(command: string): CommandIntent {
  const first = extractFirstCommand(command);

  if (DESTRUCTIVE_COMMANDS.has(first)) return "destructive";
  if (NETWORK_COMMANDS.has(first)) return "network";
  if (PACKAGE_MGMT_COMMANDS.has(first)) return "package-mgmt";

  if (READ_ONLY_COMMANDS.has(first)) {
    // sed -i performs in-place edits — not read-only
    if (first === "sed" && /\s-[a-zA-Z]*i/.test(command)) return "other";
    return "read-only";
  }

  if (first === "git") {
    const sub = gitSubcommand(command);
    return sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(sub)
      ? "read-only"
      : "other";
  }

  return "other";
}

/**
 * Validate a bash command before execution.
 *
 * Rules applied (in order):
 *  1. In readOnly mode, any non-read-only intent → block.
 *  2. Write redirections to system paths → warn.
 *  3. Known destructive patterns (rm -rf /, fork bomb, raw disk writes) → warn.
 *  4. Any remaining `rm -rf` → warn.
 *  5. Always-destructive commands (shred) when not already blocked → warn.
 */
export function validateCommand(
  command: string,
  opts: { readOnly: boolean },
): ValidationResult {
  const intent = classifyCommandIntent(command);

  // 1. Read-only mode: block anything that isn't a read-only operation
  if (opts.readOnly && intent !== "read-only") {
    const first = extractFirstCommand(command);
    return {
      decision: "block",
      reason: `'${first}' is not allowed in read-only mode (intent: ${intent})`,
    };
  }

  // 1b. Also block write redirections in read-only mode
  if (opts.readOnly && /(?<![<>])>/.test(command)) {
    return {
      decision: "block",
      reason: "Write redirection '>' is not allowed in read-only mode",
    };
  }

  // 2. Warn on writes to system paths
  const first = extractFirstCommand(command);
  const isWriteCmd = WRITE_COMMANDS.has(first) || DESTRUCTIVE_COMMANDS.has(first);
  if (isWriteCmd) {
    for (const sysPath of SYSTEM_PATHS) {
      if (command.includes(sysPath)) {
        return {
          decision: "warn",
          message: `Command targets a system path ('${sysPath}') — verify this is intentional`,
        };
      }
    }
  }

  // 3. Known destructive patterns
  for (const [pattern, message] of DESTRUCTIVE_PATTERNS) {
    if (command.includes(pattern)) {
      return { decision: "warn", message: `Destructive command detected: ${message}` };
    }
  }

  // 4. Any remaining rm -rf
  if (
    command.includes("rm ") &&
    command.includes("-r") &&
    command.includes("-f")
  ) {
    return {
      decision: "warn",
      message: "Recursive forced deletion detected — verify the target path is correct",
    };
  }

  // 5. Always-destructive commands not yet caught above
  if (first === "shred" || first === "wipefs") {
    return {
      decision: "warn",
      message: `'${first}' is inherently destructive and may cause data loss`,
    };
  }

  return { decision: "allow" };
}
