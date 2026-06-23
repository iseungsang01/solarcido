import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDiagnostics,
  formatDiagnostics,
  defaultServerForFile,
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

test("formatDiagnostics renders 1-based positions or a clean empty message", () => {
  assert.match(formatDiagnostics("a.ts", []), /No diagnostics/);
  const text = formatDiagnostics("a.ts", [
    { path: "a.ts", line: 2, character: 4, severity: "warning", message: "hi", source: "x" },
  ]);
  assert.match(text, /3:5 warning: hi \(x\)/);
});
