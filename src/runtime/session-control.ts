// Per-worktree session store with workspace-fingerprint namespacing.
// Ported from claw-rust/crates/runtime/src/session_control.rs.
//
// The fingerprint + path-layout logic is ported faithfully. Filesystem access
// is injectable (FsAdapter) so unit tests can exercise fingerprint and path
// computation without touching the real filesystem.

import * as path from "node:path";

// ---------------------------------------------------------------------------
// FNV-1a 64-bit (same algorithm as prompt-cache.ts, inlined to keep this
// module self-contained and avoid a circular import)
// ---------------------------------------------------------------------------

const FNV_OFFSET_HI = 0xcbf29ce4 >>> 0;
const FNV_OFFSET_LO = 0x84222325 >>> 0;
const FNV_PRIME_HI = 0x00000100 >>> 0;
const FNV_PRIME_LO = 0x000001b3 >>> 0;

function mul64(aHi: number, aLo: number, bHi: number, bLo: number): [number, number] {
  const aL = aLo & 0xffff;
  const aM = (aLo >>> 16) & 0xffff;
  const aH = aHi & 0xffff;
  const aHH = (aHi >>> 16) & 0xffff;
  const bL = bLo & 0xffff;
  const bM = (bLo >>> 16) & 0xffff;
  const bH = bHi & 0xffff;

  let lo = Math.imul(aL, bL);
  let carry = (lo >>> 16) + Math.imul(aM, bL) + Math.imul(aL, bM);
  lo = ((carry & 0xffff) << 16) | (lo & 0xffff);
  let hi =
    (carry >>> 16) +
    Math.imul(aH, bL) +
    Math.imul(aM, bM) +
    Math.imul(aL, bH) +
    Math.imul(aHH, bL) +
    Math.imul(aH, bM) +
    Math.imul(aM, bH) +
    Math.imul(aL, (bHi >>> 16) & 0xffff);
  return [hi >>> 0, lo >>> 0];
}

const TEXT_ENCODER = new TextEncoder();

function fnv1a64(bytes: Uint8Array): [number, number] {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    [hi, lo] = mul64(hi, lo, FNV_PRIME_HI, FNV_PRIME_LO);
  }
  return [hi, lo];
}

// ---------------------------------------------------------------------------
// workspace fingerprint
// ---------------------------------------------------------------------------

/**
 * Stable 16-character lowercase hex digest of a workspace path string.
 * Uses FNV-1a 64-bit — identical to the Rust implementation.
 *
 * The function is pure (no I/O): callers must pass the canonicalized path
 * to ensure equivalent representations produce the same fingerprint.
 */
export function workspaceFingerprint(workspacePath: string): string {
  const bytes = TEXT_ENCODER.encode(workspacePath);
  const [hi, lo] = fnv1a64(bytes);
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Session file extensions (mirrors Rust constants)
// ---------------------------------------------------------------------------

export const PRIMARY_SESSION_EXTENSION = "jsonl";
export const LEGACY_SESSION_EXTENSION = "json";

/** Reference aliases for "most recent session". */
export const SESSION_REFERENCE_ALIASES = ["latest", "last", "recent"] as const;
export type SessionReferenceAlias = (typeof SESSION_REFERENCE_ALIASES)[number];

export function isSessionReferenceAlias(reference: string): boolean {
  return (SESSION_REFERENCE_ALIASES as readonly string[]).includes(
    reference.toLowerCase(),
  );
}

export function isManagedSessionFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1);
  return ext === PRIMARY_SESSION_EXTENSION || ext === LEGACY_SESSION_EXTENSION;
}

// ---------------------------------------------------------------------------
// Injectable filesystem adapter
// ---------------------------------------------------------------------------

/**
 * Minimal FS surface needed by SessionStore.
 * The default implementation delegates to `node:fs/promises` + `node:path`.
 * Tests can inject a mock to avoid real I/O.
 */
export type FsAdapter = {
  /** Resolve a path to its canonical form (follows symlinks). May throw. */
  realpath(p: string): Promise<string>;
  /** Create directory and all parents. */
  mkdir(p: string): Promise<void>;
  /** Return true if a path exists (file or directory). */
  exists(p: string): Promise<boolean>;
  /** List file names in a directory. Returns [] if directory absent. */
  readdir(p: string): Promise<string[]>;
  /** Return mtime as milliseconds since epoch, or 0 on error. */
  mtimeMs(p: string): Promise<number>;
};

/** Real-filesystem adapter (default). */
export function realFsAdapter(): FsAdapter {
  // Lazy-require to keep this module importable without dynamic-import in tests.
  const fs = await_fs();
  return {
    realpath: (p) => fs.realpath(p),
    mkdir: (p) => fs.mkdir(p, { recursive: true }),
    exists: async (p) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    readdir: async (p) => {
      try {
        return await fs.readdir(p);
      } catch {
        return [];
      }
    },
    mtimeMs: async (p) => {
      try {
        const stat = await fs.stat(p);
        return stat.mtimeMs;
      } catch {
        return 0;
      }
    },
  };
}

// Node fs/promises is loaded lazily so the module can be imported in tests
// that inject a mock without triggering real I/O at import time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fs: any = null;
function await_fs() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (_fs === null) _fs = require("node:fs/promises");
  return _fs;
}

// ---------------------------------------------------------------------------
// Path-layout helpers (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * Compute the sessions root for a cwd-based store.
 * Layout: `<canonicalCwd>/.claw/sessions/<fingerprint>/`
 */
export function cwdSessionsRoot(canonicalCwd: string): string {
  return path.join(canonicalCwd, ".claw", "sessions", workspaceFingerprint(canonicalCwd));
}

/**
 * Compute the sessions root for a data-dir-based store.
 * Layout: `<dataDir>/sessions/<fingerprint>/`
 */
export function dataDirSessionsRoot(dataDir: string, canonicalWorkspace: string): string {
  return path.join(dataDir, "sessions", workspaceFingerprint(canonicalWorkspace));
}

/** Legacy (non-fingerprinted) sessions root inside a cwd. */
export function legacySessionsRoot(sessionsRoot: string): string | undefined {
  const parent = path.dirname(sessionsRoot);
  if (path.basename(parent) === "sessions") return parent;
  return undefined;
}

/** Derive session id from a session file path (strips extension). */
export function sessionIdFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  for (const ext of [PRIMARY_SESSION_EXTENSION, LEGACY_SESSION_EXTENSION]) {
    if (base.endsWith(`.${ext}`)) return base.slice(0, -(ext.length + 1));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session handle
// ---------------------------------------------------------------------------

export type SessionHandle = {
  id: string;
  path: string;
};

/** Build the managed path for a session id inside a sessions root. */
export function sessionHandlePath(sessionsRoot: string, sessionId: string): string {
  return path.join(sessionsRoot, `${sessionId}.${PRIMARY_SESSION_EXTENSION}`);
}

// ---------------------------------------------------------------------------
// Session summary (lightweight — no message contents)
// ---------------------------------------------------------------------------

export type SessionSummary = {
  id: string;
  path: string;
  /** Semantic updated-at from the session JSON (ms since epoch). 0 when unknown. */
  updatedAtMs: number;
  /** File system mtime (ms since epoch). 0 when unknown. */
  mtimeMs: number;
  messageCount: number;
  parentSessionId: string | undefined;
  branchName: string | undefined;
};

/** Sort summaries: newest first by updatedAtMs, then mtimeMs, then id. */
export function sortSessionSummaries(summaries: SessionSummary[]): void {
  summaries.sort((a, b) => {
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.id.localeCompare(a.id);
  });
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type SessionStoreError =
  | { kind: "io"; message: string }
  | { kind: "notFound"; reference: string; sessionsRoot: string }
  | { kind: "noSessions"; sessionsRoot: string }
  | { kind: "workspaceMismatch"; expected: string; actual: string };

export function sessionStoreErrorMessage(error: SessionStoreError): string {
  switch (error.kind) {
    case "io":
      return error.message;
    case "notFound": {
      const fp = path.basename(error.sessionsRoot);
      return (
        `session not found: ${error.reference}\n` +
        `Hint: managed sessions live in .claw/sessions/${fp}/ (workspace-specific partition).\n` +
        `Try \`latest\` for the most recent session or \`/session list\` in the REPL.`
      );
    }
    case "noSessions": {
      const fp = path.basename(error.sessionsRoot);
      return (
        `no managed sessions found in .claw/sessions/${fp}/\n` +
        `Start the assistant to create a session, then rerun with \`--resume latest\`.\n` +
        `Note: sessions are partitioned per workspace fingerprint; sessions from other CWDs are invisible.`
      );
    }
    case "workspaceMismatch":
      return `session workspace mismatch: expected ${error.expected}, found ${error.actual}`;
  }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/**
 * Per-worktree session store.
 *
 * Construct with `SessionStore.fromCwd()` or `SessionStore.fromDataDir()`.
 * Both constructors canonicalize paths before fingerprinting (#151 parity).
 *
 * The `fs` parameter is injectable so callers can test fingerprint/path
 * computation without real filesystem access.
 */
export class SessionStore {
  readonly sessionsRoot: string;
  readonly workspaceRoot: string;
  private readonly fs: FsAdapter;

  private constructor(sessionsRoot: string, workspaceRoot: string, fs: FsAdapter) {
    this.sessionsRoot = sessionsRoot;
    this.workspaceRoot = workspaceRoot;
    this.fs = fs;
  }

  /** Build a store from the server's current working directory. */
  static async fromCwd(cwd: string, fs: FsAdapter): Promise<SessionStore> {
    let canonical: string;
    try {
      canonical = await fs.realpath(cwd);
    } catch {
      canonical = cwd;
    }
    const sessionsRoot = cwdSessionsRoot(canonical);
    await fs.mkdir(sessionsRoot);
    return new SessionStore(sessionsRoot, canonical, fs);
  }

  /** Build a store from an explicit data directory. */
  static async fromDataDir(
    dataDir: string,
    workspaceRoot: string,
    fs: FsAdapter,
  ): Promise<SessionStore> {
    let canonical: string;
    try {
      canonical = await fs.realpath(workspaceRoot);
    } catch {
      canonical = workspaceRoot;
    }
    const sessionsRoot = dataDirSessionsRoot(dataDir, canonical);
    await fs.mkdir(sessionsRoot);
    return new SessionStore(sessionsRoot, canonical, fs);
  }

  /** Create a session handle (path + id) without writing anything to disk. */
  createHandle(sessionId: string): SessionHandle {
    return {
      id: sessionId,
      path: sessionHandlePath(this.sessionsRoot, sessionId),
    };
  }

  /**
   * Resolve a reference string to a SessionHandle.
   * Accepts alias keywords ("latest", "last", "recent"), absolute paths,
   * relative paths (resolved from workspaceRoot), and bare session ids.
   */
  async resolveReference(
    reference: string,
    loadSummary?: (filePath: string) => Promise<Pick<SessionSummary, "id" | "updatedAtMs" | "messageCount" | "parentSessionId" | "branchName"> | undefined>,
  ): Promise<{ ok: true; handle: SessionHandle } | { ok: false; error: SessionStoreError }> {
    if (isSessionReferenceAlias(reference)) {
      const latestResult = await this.latestSession(loadSummary);
      if (!latestResult.ok) return latestResult;
      return { ok: true, handle: { id: latestResult.summary.id, path: latestResult.summary.path } };
    }

    // Absolute or relative path
    const candidate = path.isAbsolute(reference)
      ? reference
      : path.join(this.workspaceRoot, reference);
    const hasExtension = path.extname(reference).length > 0;
    const hasDirectoryPart = reference.includes(path.sep) || reference.includes("/");

    if (hasExtension || hasDirectoryPart) {
      if (await this.fs.exists(candidate)) {
        const id = sessionIdFromPath(candidate) ?? reference;
        return { ok: true, handle: { id, path: candidate } };
      }
      return { ok: false, error: { kind: "notFound", reference, sessionsRoot: this.sessionsRoot } };
    }

    // Bare session id — check primary then legacy extension
    for (const ext of [PRIMARY_SESSION_EXTENSION, LEGACY_SESSION_EXTENSION]) {
      const p = path.join(this.sessionsRoot, `${reference}.${ext}`);
      if (await this.fs.exists(p)) {
        return { ok: true, handle: { id: reference, path: p } };
      }
    }

    return { ok: false, error: { kind: "notFound", reference, sessionsRoot: this.sessionsRoot } };
  }

  /**
   * List all session summaries in this store's namespace.
   * Requires a `loadSummary` callback to parse session files; this keeps
   * the module free of any session-JSON schema dependency.
   */
  async listSessions(
    loadSummary?: (filePath: string) => Promise<Pick<SessionSummary, "id" | "updatedAtMs" | "messageCount" | "parentSessionId" | "branchName"> | undefined>,
  ): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    await this.collectFromDir(this.sessionsRoot, summaries, loadSummary);

    const legacyRoot = legacySessionsRoot(this.sessionsRoot);
    if (legacyRoot !== undefined) {
      await this.collectFromDir(legacyRoot, summaries, loadSummary);
    }

    sortSessionSummaries(summaries);
    return summaries;
  }

  /** Return the most recently updated session, or an error if none exist. */
  async latestSession(
    loadSummary?: (filePath: string) => Promise<Pick<SessionSummary, "id" | "updatedAtMs" | "messageCount" | "parentSessionId" | "branchName"> | undefined>,
  ): Promise<{ ok: true; summary: SessionSummary } | { ok: false; error: SessionStoreError }> {
    const sessions = await this.listSessions(loadSummary);
    if (sessions.length === 0) {
      return { ok: false, error: { kind: "noSessions", sessionsRoot: this.sessionsRoot } };
    }
    return { ok: true, summary: sessions[0] };
  }

  private async collectFromDir(
    dir: string,
    out: SessionSummary[],
    loadSummary?: (filePath: string) => Promise<Pick<SessionSummary, "id" | "updatedAtMs" | "messageCount" | "parentSessionId" | "branchName"> | undefined>,
  ): Promise<void> {
    const names = await this.fs.readdir(dir);
    for (const name of names) {
      const fullPath = path.join(dir, name);
      if (!isManagedSessionFile(fullPath)) continue;
      const mtimeMs = await this.fs.mtimeMs(fullPath);
      const id = sessionIdFromPath(fullPath) ?? name;
      let parsed: Pick<SessionSummary, "id" | "updatedAtMs" | "messageCount" | "parentSessionId" | "branchName"> = {
        id,
        updatedAtMs: 0,
        messageCount: 0,
        parentSessionId: undefined,
        branchName: undefined,
      };
      if (loadSummary !== undefined) {
        const loaded = await loadSummary(fullPath);
        if (loaded !== undefined) parsed = loaded;
      }
      out.push({ ...parsed, path: fullPath, mtimeMs });
    }
  }
}
