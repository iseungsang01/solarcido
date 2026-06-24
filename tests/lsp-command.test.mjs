import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  collectDiagnostics,
  formatDiagnostics,
  defaultServerForFile,
  findProjectRoot,
  languageIdForFile,
  pathToFileUri,
  parseServerCommand,
} from "../dist/workflow/lsp-command.js";
import { uriToPath } from "../dist/runtime/lsp/client.js";

test("defaultServerForFile and languageIdForFile map by extension", () => {
  assert.equal(defaultServerForFile("a.ts")?.command, "typescript-language-server");
  assert.equal(defaultServerForFile("a.unknownext"), undefined);
  assert.equal(languageIdForFile("a.py"), "python");
  assert.equal(languageIdForFile("a.xyz"), "plaintext");
});

test("pathToFileUri round-trips with uriToPath", () => {
  const p = process.platform === "win32" ? "C:/Users/x/a.ts" : "/home/x/a.ts";
  const uri = pathToFileUri(p);
  assert.match(uri, /^file:\/\//);
  assert.equal(uriToPath(uri).replace(/\\/g, "/"), p);
});

test("parseServerCommand splits a command + args, or returns undefined", () => {
  assert.deepEqual(parseServerCommand("typescript-language-server --stdio"), {
    command: "typescript-language-server",
    args: ["--stdio"],
  });
  assert.equal(parseServerCommand(undefined), undefined);
});

test("collectDiagnostics drives initialize -> didOpen -> diagnostics -> shutdown", async () => {
  const calls = [];
  const diag = { path: "/x/a.ts", line: 2, character: 4, severity: "error", message: "boom", source: "ts" };
  const session = {
    uri: undefined,
    async initialize(rootUri) {
      calls.push(["init", rootUri]);
    },
    async didOpen(uri, languageId) {
      calls.push(["open", languageId]);
      this.uri = uri;
    },
    diagnostics(uri) {
      return uri === this.uri ? [diag] : [];
    },
    async shutdown() {
      calls.push(["shutdown"]);
    },
  };
  const diags = await collectDiagnostics(session, "x.ts", "const a = 1", { settleMs: 0 });
  assert.deepEqual(diags, [diag]);
  assert.deepEqual(calls.map((c) => c[0]), ["init", "open", "shutdown"]);
});

test("collectDiagnostics tears down the session even when initialize rejects", async () => {
  const calls = [];
  const session = {
    async initialize() {
      throw new Error("init failed");
    },
    async didOpen() {
      calls.push(["open"]);
    },
    diagnostics() {
      return [];
    },
    async shutdown() {
      calls.push(["shutdown"]);
    },
  };
  await assert.rejects(collectDiagnostics(session, "x.ts", "code", { settleMs: 0 }));
  assert.ok(calls.some((c) => c[0] === "shutdown"), "shutdown should still run after an init failure");
});

test("findProjectRoot walks up to a directory containing a marker", () => {
  // This test file lives under <repo>/tests; the repo root holds package.json.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = findProjectRoot(path.join(here, "somefile.ts"));
  assert.equal(typeof root, "string");
  assert.ok(existsSync(path.join(root, "package.json")), "resolved root should contain package.json");
});

test("formatDiagnostics renders 1-based positions or a clean empty message", () => {
  assert.match(formatDiagnostics("a.ts", []), /No diagnostics/);
  const text = formatDiagnostics("a.ts", [
    { path: "a.ts", line: 2, character: 4, severity: "warning", message: "hi", source: "x" },
  ]);
  assert.match(text, /3:5 warning: hi \(x\)/);
});
