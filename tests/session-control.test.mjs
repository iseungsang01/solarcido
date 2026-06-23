import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceFingerprint,
  cwdSessionsRoot,
  dataDirSessionsRoot,
  legacySessionsRoot,
  sessionIdFromPath,
  sessionHandlePath,
  isManagedSessionFile,
  isSessionReferenceAlias,
  sortSessionSummaries,
  SessionStore,
  sessionStoreErrorMessage,
  PRIMARY_SESSION_EXTENSION,
  LEGACY_SESSION_EXTENSION,
} from "../dist/runtime/session-control.js";

import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// workspaceFingerprint — pure, deterministic
// ---------------------------------------------------------------------------

test("workspaceFingerprint: same path always yields same 16-char hex string", () => {
  const fp1 = workspaceFingerprint("/tmp/worktree-alpha");
  const fp2 = workspaceFingerprint("/tmp/worktree-alpha");
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 16);
  assert.match(fp1, /^[0-9a-f]{16}$/);
});

test("workspaceFingerprint: different paths yield different fingerprints", () => {
  const fpA = workspaceFingerprint("/tmp/worktree-alpha");
  const fpB = workspaceFingerprint("/tmp/worktree-beta");
  assert.notEqual(fpA, fpB);
});

test("workspaceFingerprint: empty string is stable", () => {
  const fp = workspaceFingerprint("");
  assert.equal(fp.length, 16);
  assert.equal(fp, workspaceFingerprint(""));
});

// ---------------------------------------------------------------------------
// cwdSessionsRoot / dataDirSessionsRoot — pure path layout
// ---------------------------------------------------------------------------

test("cwdSessionsRoot: layout is <cwd>/.claw/sessions/<fingerprint>", () => {
  const cwd = "/home/user/project";
  const root = cwdSessionsRoot(cwd);
  const fp = workspaceFingerprint(cwd);
  const expected = nodePath.join(cwd, ".claw", "sessions", fp);
  assert.equal(root, expected);
});

test("cwdSessionsRoot: different cwds produce different roots", () => {
  assert.notEqual(cwdSessionsRoot("/a"), cwdSessionsRoot("/b"));
});

test("dataDirSessionsRoot: layout is <dataDir>/sessions/<fingerprint>", () => {
  const dataDir = "/var/data";
  const workspace = "/home/user/project";
  const root = dataDirSessionsRoot(dataDir, workspace);
  const fp = workspaceFingerprint(workspace);
  const expected = nodePath.join(dataDir, "sessions", fp);
  assert.equal(root, expected);
});

test("dataDirSessionsRoot: same dataDir + different workspaces yield different roots", () => {
  const dataDir = "/var/data";
  const rootA = dataDirSessionsRoot(dataDir, "/ws-alpha");
  const rootB = dataDirSessionsRoot(dataDir, "/ws-beta");
  assert.notEqual(rootA, rootB);
});

// ---------------------------------------------------------------------------
// legacySessionsRoot
// ---------------------------------------------------------------------------

test("legacySessionsRoot: returns parent when parent dir is named 'sessions'", () => {
  const sessionsRoot = nodePath.join("/project", ".claw", "sessions", "abc123def456789a");
  const legacy = legacySessionsRoot(sessionsRoot);
  assert.ok(legacy !== undefined);
  assert.equal(legacy, nodePath.join("/project", ".claw", "sessions"));
});

test("legacySessionsRoot: returns undefined when parent is not 'sessions'", () => {
  const root = nodePath.join("/project", ".claw", "other", "abc123def456789a");
  assert.equal(legacySessionsRoot(root), undefined);
});

// ---------------------------------------------------------------------------
// sessionIdFromPath
// ---------------------------------------------------------------------------

test("sessionIdFromPath: strips primary extension", () => {
  const p = nodePath.join("/sessions", `my-session.${PRIMARY_SESSION_EXTENSION}`);
  assert.equal(sessionIdFromPath(p), "my-session");
});

test("sessionIdFromPath: strips legacy extension", () => {
  const p = nodePath.join("/sessions", `old-session.${LEGACY_SESSION_EXTENSION}`);
  assert.equal(sessionIdFromPath(p), "old-session");
});

test("sessionIdFromPath: returns undefined for unknown extension", () => {
  const p = nodePath.join("/sessions", "something.txt");
  assert.equal(sessionIdFromPath(p), undefined);
});

// ---------------------------------------------------------------------------
// sessionHandlePath
// ---------------------------------------------------------------------------

test("sessionHandlePath: builds correct managed path", () => {
  const root = nodePath.join("/sessions", "abc123");
  const p = sessionHandlePath(root, "sess-42");
  assert.equal(p, nodePath.join(root, `sess-42.${PRIMARY_SESSION_EXTENSION}`));
});

// ---------------------------------------------------------------------------
// isManagedSessionFile
// ---------------------------------------------------------------------------

test("isManagedSessionFile: accepts .jsonl and .json", () => {
  assert.ok(isManagedSessionFile(`session.${PRIMARY_SESSION_EXTENSION}`));
  assert.ok(isManagedSessionFile(`session.${LEGACY_SESSION_EXTENSION}`));
});

test("isManagedSessionFile: rejects other extensions", () => {
  assert.ok(!isManagedSessionFile("session.txt"));
  assert.ok(!isManagedSessionFile("session.yaml"));
  assert.ok(!isManagedSessionFile("Makefile"));
});

// ---------------------------------------------------------------------------
// isSessionReferenceAlias
// ---------------------------------------------------------------------------

test("isSessionReferenceAlias: recognises all alias keywords case-insensitively", () => {
  assert.ok(isSessionReferenceAlias("latest"));
  assert.ok(isSessionReferenceAlias("LATEST"));
  assert.ok(isSessionReferenceAlias("last"));
  assert.ok(isSessionReferenceAlias("recent"));
  assert.ok(isSessionReferenceAlias("Recent"));
});

test("isSessionReferenceAlias: rejects non-alias strings", () => {
  assert.ok(!isSessionReferenceAlias("sess-123"));
  assert.ok(!isSessionReferenceAlias(""));
  assert.ok(!isSessionReferenceAlias("newest"));
});

// ---------------------------------------------------------------------------
// sortSessionSummaries
// ---------------------------------------------------------------------------

function makeSummary(id, updatedAtMs, mtimeMs) {
  return { id, path: `/s/${id}.jsonl`, updatedAtMs, mtimeMs, messageCount: 1, parentSessionId: undefined, branchName: undefined };
}

test("sortSessionSummaries: sorts by updatedAtMs descending (newest first)", () => {
  const summaries = [
    makeSummary("old", 100, 200),
    makeSummary("new", 200, 100),
  ];
  sortSessionSummaries(summaries);
  assert.equal(summaries[0].id, "new");
  assert.equal(summaries[1].id, "old");
});

test("sortSessionSummaries: falls back to mtimeMs when updatedAtMs ties", () => {
  const summaries = [
    makeSummary("older-mtime", 100, 100),
    makeSummary("newer-mtime", 100, 200),
  ];
  sortSessionSummaries(summaries);
  assert.equal(summaries[0].id, "newer-mtime");
});

test("sortSessionSummaries: falls back to id when both timestamps tie", () => {
  const summaries = [
    makeSummary("zzz", 100, 100),
    makeSummary("aaa", 100, 100),
  ];
  sortSessionSummaries(summaries);
  // Descending by id: 'zzz' > 'aaa'
  assert.equal(summaries[0].id, "zzz");
  assert.equal(summaries[1].id, "aaa");
});

// ---------------------------------------------------------------------------
// sessionStoreErrorMessage
// ---------------------------------------------------------------------------

test("sessionStoreErrorMessage: io error shows message", () => {
  const msg = sessionStoreErrorMessage({ kind: "io", message: "ENOENT" });
  assert.equal(msg, "ENOENT");
});

test("sessionStoreErrorMessage: notFound includes reference and hint", () => {
  const root = nodePath.join("/project", ".claw", "sessions", "abc123def0000000");
  const msg = sessionStoreErrorMessage({ kind: "notFound", reference: "sess-99", sessionsRoot: root });
  assert.ok(msg.includes("sess-99"));
  assert.ok(msg.includes("abc123def0000000"));
  assert.ok(msg.includes("latest"));
});

test("sessionStoreErrorMessage: noSessions includes fingerprint dir", () => {
  const root = nodePath.join("/project", ".claw", "sessions", "deadbeef00000000");
  const msg = sessionStoreErrorMessage({ kind: "noSessions", sessionsRoot: root });
  assert.ok(msg.includes("deadbeef00000000"));
  assert.ok(msg.includes("--resume latest"));
});

test("sessionStoreErrorMessage: workspaceMismatch includes both paths", () => {
  const msg = sessionStoreErrorMessage({ kind: "workspaceMismatch", expected: "/ws/a", actual: "/ws/b" });
  assert.ok(msg.includes("/ws/a"));
  assert.ok(msg.includes("/ws/b"));
});

// ---------------------------------------------------------------------------
// SessionStore — via injected in-memory FsAdapter (no real I/O)
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory FsAdapter.
 * `files` is a Set of paths that "exist"; `dirs` is a Map<dir, string[]>
 * for readdir. realpath is identity (no symlink simulation needed here).
 */
function makeMemFs(existingPaths = [], dirContents = new Map()) {
  return {
    realpath: async (p) => p,
    mkdir: async () => {},
    exists: async (p) => existingPaths.includes(p),
    readdir: async (p) => dirContents.get(p) ?? [],
    mtimeMs: async () => 0,
  };
}

test("SessionStore.fromCwd: sessions root has correct layout", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project/repo", fs);
  const fp = workspaceFingerprint("/project/repo");
  const expected = nodePath.join("/project/repo", ".claw", "sessions", fp);
  assert.equal(store.sessionsRoot, expected);
  assert.equal(store.workspaceRoot, "/project/repo");
});

test("SessionStore.fromDataDir: sessions root has correct layout", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromDataDir("/global/data", "/project/repo", fs);
  const fp = workspaceFingerprint("/project/repo");
  const expected = nodePath.join("/global/data", "sessions", fp);
  assert.equal(store.sessionsRoot, expected);
  assert.equal(store.workspaceRoot, "/project/repo");
});

test("SessionStore: different workspaces produce different session roots", async () => {
  const fs = makeMemFs();
  const storeA = await SessionStore.fromCwd("/ws/alpha", fs);
  const storeB = await SessionStore.fromCwd("/ws/beta", fs);
  assert.notEqual(storeA.sessionsRoot, storeB.sessionsRoot);
});

test("SessionStore: createHandle builds correct path and id", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  const handle = store.createHandle("sess-42");
  assert.equal(handle.id, "sess-42");
  assert.equal(handle.path, nodePath.join(store.sessionsRoot, `sess-42.${PRIMARY_SESSION_EXTENSION}`));
});

test("SessionStore: listSessions returns summaries from readdir", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  // Inject directory contents for the sessions root.
  const root = store.sessionsRoot;
  const fileName = `sess-1.${PRIMARY_SESSION_EXTENSION}`;
  const memFs = makeMemFs(
    [nodePath.join(root, fileName)],
    new Map([[root, [fileName]]]),
  );
  const store2 = await SessionStore.fromCwd("/project", memFs);
  const sessions = await store2.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "sess-1");
});

test("SessionStore: listSessions skips non-session files", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  const root = store.sessionsRoot;
  // Mix managed and non-managed file names.
  const memFs = makeMemFs([], new Map([[root, ["valid.jsonl", "notes.txt", "other.yaml"]]]));
  const store2 = await SessionStore.fromCwd("/project", memFs);
  const sessions = await store2.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "valid");
});

test("SessionStore: listSessions returns empty array when directory is empty", async () => {
  const memFs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", memFs);
  const sessions = await store.listSessions();
  assert.deepEqual(sessions, []);
});

test("SessionStore: latestSession errors when no sessions exist", async () => {
  const memFs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", memFs);
  const result = await store.latestSession();
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "noSessions");
});

test("SessionStore: latestSession returns the session with highest updatedAtMs", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  const root = store.sessionsRoot;
  const files = ["old.jsonl", "new.jsonl"];
  // loadSummary returns mock data
  const loadSummary = async (p) => ({
    id: nodePath.basename(p, ".jsonl"),
    updatedAtMs: p.includes("new") ? 200 : 100,
    messageCount: 1,
    parentSessionId: undefined,
    branchName: undefined,
  });
  const memFs = makeMemFs(
    files.map((f) => nodePath.join(root, f)),
    new Map([[root, files]]),
  );
  const store2 = await SessionStore.fromCwd("/project", memFs);
  const result = await store2.latestSession(loadSummary);
  assert.ok(result.ok);
  assert.equal(result.summary.id, "new");
});

test("SessionStore: resolveReference with alias resolves to latest", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  const root = store.sessionsRoot;
  const memFs = makeMemFs(
    [nodePath.join(root, "sess-a.jsonl")],
    new Map([[root, ["sess-a.jsonl"]]]),
  );
  const store2 = await SessionStore.fromCwd("/project", memFs);
  const loadSummary = async (p) => ({
    id: nodePath.basename(p, ".jsonl"),
    updatedAtMs: 999,
    messageCount: 0,
    parentSessionId: undefined,
    branchName: undefined,
  });
  const result = await store2.resolveReference("latest", loadSummary);
  assert.ok(result.ok);
  assert.equal(result.handle.id, "sess-a");
});

test("SessionStore: resolveReference with bare session id finds existing file", async () => {
  const fs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", fs);
  const root = store.sessionsRoot;
  const sessionPath = nodePath.join(root, `sess-99.${PRIMARY_SESSION_EXTENSION}`);
  const memFs = makeMemFs([sessionPath], new Map([[root, [`sess-99.${PRIMARY_SESSION_EXTENSION}`]]]));
  const store2 = await SessionStore.fromCwd("/project", memFs);
  const result = await store2.resolveReference("sess-99");
  assert.ok(result.ok);
  assert.equal(result.handle.id, "sess-99");
  assert.equal(result.handle.path, sessionPath);
});

test("SessionStore: resolveReference with missing id returns notFound error", async () => {
  const memFs = makeMemFs();
  const store = await SessionStore.fromCwd("/project", memFs);
  const result = await store.resolveReference("does-not-exist");
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "notFound");
});
