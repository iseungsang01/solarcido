// Generic startup-trust gate: resolver, config, and decision types.
// Ported from claw-rust/crates/runtime/src/trust_resolver.rs.
// Provider-neutral: "trust" is a path-allowlist gate, not vendor-specific.

// ---------------------------------------------------------------------------
// TrustPolicy
// ---------------------------------------------------------------------------

/** Resolution method applied to a trust decision. */
export type TrustPolicy = "auto_trust" | "require_approval" | "deny";

// ---------------------------------------------------------------------------
// TrustResolution
// ---------------------------------------------------------------------------

/** How the trust gate was resolved. */
export type TrustResolution = "auto_allowlisted" | "manual_approval";

// ---------------------------------------------------------------------------
// TrustEvent — discriminated union
// ---------------------------------------------------------------------------

export type TrustEvent =
  | {
      type: "trust_required";
      cwd: string;
      repo: string | undefined;
      worktree: string | undefined;
    }
  | {
      type: "trust_resolved";
      cwd: string;
      policy: TrustPolicy;
      resolution: TrustResolution;
    }
  | {
      type: "trust_denied";
      cwd: string;
      reason: string;
    };

// ---------------------------------------------------------------------------
// TrustAllowlistEntry
// ---------------------------------------------------------------------------

/** Entry in the trust allowlist with optional glob-pattern matching. */
export type TrustAllowlistEntry = {
  /** Path or glob pattern to match against the cwd. */
  pattern: string;
  /** Optional worktree subpath pattern. */
  worktreePattern: string | undefined;
  /** Human-readable description. */
  description: string | undefined;
};

export function makeTrustAllowlistEntry(
  pattern: string,
  worktreePattern?: string,
  description?: string,
): TrustAllowlistEntry {
  return { pattern, worktreePattern, description };
}

// ---------------------------------------------------------------------------
// TrustConfig
// ---------------------------------------------------------------------------

/** Configuration for the trust resolver. */
export type TrustConfig = {
  allowlisted: TrustAllowlistEntry[];
  denied: string[];
  emitEvents: boolean;
};

export function makeTrustConfig(overrides?: Partial<TrustConfig>): TrustConfig {
  return {
    allowlisted: [],
    denied: [],
    emitEvents: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Glob match with * (any sequence) and ? (single character). */
function globMatchRecursive(pattern: string, path: string, p: number, s: number): boolean {
  const pc = [...pattern];
  const sc = [...path];

  while (p < pc.length) {
    const ch = pc[p];
    if (ch === "*") {
      p += 1;
      if (p >= pc.length) return true;
      for (let skip = 0; skip <= sc.length - s; skip++) {
        if (globMatchRecursive(pattern, path, p, s + skip)) return true;
      }
      return false;
    } else if (ch === "?") {
      if (s >= sc.length) return false;
      p++;
      s++;
    } else {
      if (s >= sc.length || sc[s] !== ch) return false;
      p++;
      s++;
    }
  }
  return s >= sc.length;
}

function globMatches(pattern: string, path: string): boolean {
  return globMatchRecursive(pattern, path, 0, 0);
}

/** Match a pattern against a path — supports exact, prefix, wildcard, and glob. */
export function patternMatches(pattern: string, path: string): boolean {
  const p = normPath(pattern.trim());
  const s = normPath(path.trim());

  if (p === s) return true;

  // Prefix match without wildcards.
  if (!p.includes("*") && !p.includes("?")) {
    if (s.startsWith(p)) {
      const rest = s.slice(p.length);
      return rest === "" || rest.startsWith("/");
    }
  }

  // Trailing /* pattern.
  if (p.endsWith("/*")) {
    const prefix = p.slice(0, -2);
    const rest = s.slice(prefix.length);
    return s.startsWith(prefix) && (rest === "" || rest.startsWith("/"));
  }

  // Trailing * (non-path component).
  if (p.endsWith("*") && !p.includes("/*/")) {
    const prefix = p.slice(0, -1);
    const rest = s.slice(prefix.length);
    return s.startsWith(prefix) && (rest === "" || !rest.startsWith("/"));
  }

  // Path-component exact match.
  if (s.split("/").includes(p)) return true;

  // Path-component substring match.
  if (s.split("/").some((c) => c.includes(p))) return true;

  // Full glob matching for patterns with ? or mid-path *.
  if (p.includes("?") || p.includes("/*/") || p.startsWith("*/")) {
    return globMatches(p, s);
  }

  return false;
}

/** Check if a cwd matches any allowlist entry (with optional worktree). */
function isAllowlisted(
  config: TrustConfig,
  cwd: string,
  worktree: string | undefined,
): TrustAllowlistEntry | undefined {
  return config.allowlisted.find((entry) => {
    if (!patternMatches(entry.pattern, cwd)) return false;
    if (entry.worktreePattern !== undefined) {
      if (worktree === undefined) return false;
      return patternMatches(entry.worktreePattern, worktree);
    }
    return true;
  });
}

function isDenied(config: TrustConfig, cwd: string): string | undefined {
  return config.denied.find((root) => {
    const r = normPath(root);
    const c = normPath(cwd);
    return c === r || c.startsWith(r + "/");
  });
}

// ---------------------------------------------------------------------------
// Screen-text detection helpers (re-exported for tests)
// ---------------------------------------------------------------------------

const TRUST_PROMPT_CUES = [
  "do you trust the files in this folder",
  "trust the files in this folder",
  "trust this folder",
  "allow and continue",
  "yes, proceed",
];

const MANUAL_APPROVAL_CUES = [
  "yes, i trust",
  "i trust this",
  "trusted manually",
  "approval granted",
];

/** True when the screen text contains a recognisable trust prompt. */
export function detectTrustPrompt(screenText: string): boolean {
  const lowered = screenText.toLowerCase();
  return TRUST_PROMPT_CUES.some((cue) => lowered.includes(cue));
}

/** True when the screen text indicates the user manually approved trust. */
export function detectManualApproval(screenText: string): boolean {
  const lowered = screenText.toLowerCase();
  return MANUAL_APPROVAL_CUES.some((cue) => lowered.includes(cue));
}

// ---------------------------------------------------------------------------
// TrustDecision — discriminated union
// ---------------------------------------------------------------------------

export type TrustDecision =
  | { kind: "not_required" }
  | { kind: "required"; policy: TrustPolicy; events: TrustEvent[] };

export function trustDecisionPolicy(decision: TrustDecision): TrustPolicy | undefined {
  return decision.kind === "required" ? decision.policy : undefined;
}

export function trustDecisionEvents(decision: TrustDecision): readonly TrustEvent[] {
  return decision.kind === "required" ? decision.events : [];
}

// ---------------------------------------------------------------------------
// Repository name extraction
// ---------------------------------------------------------------------------

function extractRepoName(cwd: string): string | undefined {
  // Best-effort: return the last path component as the repo name.
  const parts = normPath(cwd).split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// TrustResolver
// ---------------------------------------------------------------------------

/** Stateless trust resolver — call resolve() per observed screen frame. */
export class TrustResolver {
  private readonly config: TrustConfig;

  constructor(config: TrustConfig) {
    this.config = config;
  }

  /**
   * Analyse the screen text for a trust prompt and return the trust decision.
   * No trust prompt in the screen text → NotRequired (no events emitted).
   */
  resolve(cwd: string, worktree: string | undefined, screenText: string): TrustDecision {
    if (!detectTrustPrompt(screenText)) {
      return { kind: "not_required" };
    }

    const repo = extractRepoName(cwd);
    const events: TrustEvent[] = [
      { type: "trust_required", cwd, repo, worktree },
    ];

    // Denylist takes priority over allowlist.
    const deniedRoot = isDenied(this.config, cwd);
    if (deniedRoot !== undefined) {
      const reason = `cwd matches denied trust root: ${deniedRoot}`;
      events.push({ type: "trust_denied", cwd, reason });
      return { kind: "required", policy: "deny", events };
    }

    // Allowlist check.
    if (isAllowlisted(this.config, cwd, worktree) !== undefined) {
      events.push({
        type: "trust_resolved",
        cwd,
        policy: "auto_trust",
        resolution: "auto_allowlisted",
      });
      return { kind: "required", policy: "auto_trust", events };
    }

    // Manual approval detected from screen text.
    if (detectManualApproval(screenText)) {
      events.push({
        type: "trust_resolved",
        cwd,
        policy: "require_approval",
        resolution: "manual_approval",
      });
      return { kind: "required", policy: "require_approval", events };
    }

    return { kind: "required", policy: "require_approval", events };
  }

  /**
   * Quick predicate: true when the cwd is allowlisted and not denied.
   * Does not require a screen observation.
   */
  trusts(cwd: string, worktree: string | undefined): boolean {
    if (isDenied(this.config, cwd) !== undefined) return false;
    return isAllowlisted(this.config, cwd, worktree) !== undefined;
  }
}
