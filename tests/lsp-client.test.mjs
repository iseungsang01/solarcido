import assert from "node:assert/strict";
import test from "node:test";

import {
  lspActionFromString,
  lspServerStatusToString,
  LspRegistry,
} from "../dist/runtime/lsp-client.js";

// ---------------------------------------------------------------------------
// lspActionFromString — alias resolution
// ---------------------------------------------------------------------------

test("lspActionFromString: all primary names resolve", () => {
  const cases = [
    ["diagnostics", "diagnostics"],
    ["hover", "hover"],
    ["definition", "definition"],
    ["references", "references"],
    ["completion", "completion"],
    ["symbols", "symbols"],
    ["format", "format"],
  ];
  for (const [input, expectedKind] of cases) {
    const action = lspActionFromString(input);
    assert.ok(action !== undefined, `${input} should resolve`);
    assert.equal(action.kind, expectedKind);
  }
});

test("lspActionFromString: aliases resolve to the canonical action", () => {
  const aliases = [
    ["goto_definition", "definition"],
    ["find_references", "references"],
    ["completions", "completion"],
    ["document_symbols", "symbols"],
    ["formatting", "format"],
  ];
  for (const [alias, expectedKind] of aliases) {
    const action = lspActionFromString(alias);
    assert.ok(action !== undefined, `alias ${alias} should resolve`);
    assert.equal(action.kind, expectedKind, `alias ${alias} expected kind ${expectedKind}`);
  }
});

test("lspActionFromString: unknown string returns undefined", () => {
  assert.equal(lspActionFromString("unknown_action"), undefined);
  assert.equal(lspActionFromString(""), undefined);
  assert.equal(lspActionFromString("HOVER"), undefined); // case-sensitive
});

// ---------------------------------------------------------------------------
// lspServerStatusToString
// ---------------------------------------------------------------------------

test("lspServerStatusToString: all status variants format correctly", () => {
  const cases = [
    [{ kind: "connected" }, "connected"],
    [{ kind: "disconnected" }, "disconnected"],
    [{ kind: "starting" }, "starting"],
    [{ kind: "error" }, "error"],
  ];
  for (const [status, expected] of cases) {
    assert.equal(lspServerStatusToString(status), expected);
  }
});

// ---------------------------------------------------------------------------
// LspRegistry — register / get / list
// ---------------------------------------------------------------------------

test("LspRegistry: register and retrieve a server", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, "/workspace", ["hover", "completion"]);
  const server = reg.get("rust");
  assert.ok(server !== undefined);
  assert.equal(server.language, "rust");
  assert.equal(server.status.kind, "connected");
  assert.equal(server.rootPath, "/workspace");
  assert.deepEqual(server.capabilities, ["hover", "completion"]);
});

test("LspRegistry: get returns undefined for missing language", () => {
  const reg = new LspRegistry();
  assert.equal(reg.get("missing"), undefined);
});

test("LspRegistry: listServers returns all registered servers", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  reg.register("typescript", { kind: "starting" }, undefined, []);
  reg.register("python", { kind: "error" }, undefined, []);
  const servers = reg.listServers();
  assert.equal(servers.length, 3);
  assert.ok(servers.some((s) => s.language === "rust"));
  assert.ok(servers.some((s) => s.language === "typescript"));
  assert.ok(servers.some((s) => s.language === "python"));
});

test("LspRegistry: size and isEmpty reflect registration state", () => {
  const reg = new LspRegistry();
  assert.ok(reg.isEmpty);
  assert.equal(reg.size, 0);
  reg.register("go", { kind: "connected" }, undefined, []);
  assert.ok(!reg.isEmpty);
  assert.equal(reg.size, 1);
});

// ---------------------------------------------------------------------------
// LspRegistry — findServerForPath (extension mapping)
// ---------------------------------------------------------------------------

test("LspRegistry: findServerForPath maps all supported extensions", () => {
  const reg = new LspRegistry();
  for (const lang of ["rust", "typescript", "javascript", "python", "go", "java", "c", "cpp", "ruby", "lua"]) {
    reg.register(lang, { kind: "connected" }, undefined, []);
  }
  const cases = [
    ["src/main.rs", "rust"],
    ["src/index.ts", "typescript"],
    ["src/view.tsx", "typescript"],
    ["src/app.js", "javascript"],
    ["src/app.jsx", "javascript"],
    ["script.py", "python"],
    ["main.go", "go"],
    ["Main.java", "java"],
    ["native.c", "c"],
    ["native.h", "c"],
    ["native.cpp", "cpp"],
    ["native.hpp", "cpp"],
    ["native.cc", "cpp"],
    ["script.rb", "ruby"],
    ["script.lua", "lua"],
  ];
  for (const [filePath, expectedLang] of cases) {
    const server = reg.findServerForPath(filePath);
    assert.ok(server !== undefined, `${filePath} should resolve`);
    assert.equal(server.language, expectedLang, `${filePath} expected language ${expectedLang}`);
  }
});

test("LspRegistry: findServerForPath returns undefined for unknown extension", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  assert.equal(reg.findServerForPath("data.csv"), undefined);
  assert.equal(reg.findServerForPath("Makefile"), undefined);
});

// ---------------------------------------------------------------------------
// LspRegistry — diagnostics management
// ---------------------------------------------------------------------------

test("LspRegistry: addDiagnostics and getDiagnostics round-trip", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  const err = reg.addDiagnostics("rust", [
    { path: "src/main.rs", line: 10, character: 5, severity: "error", message: "mismatched types", source: "rust-analyzer" },
  ]);
  assert.equal(err, undefined, "addDiagnostics should succeed");
  const diags = reg.getDiagnostics("src/main.rs");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, "mismatched types");
});

test("LspRegistry: addDiagnostics returns error for unknown language", () => {
  const reg = new LspRegistry();
  const err = reg.addDiagnostics("missing", []);
  assert.ok(typeof err === "string");
  assert.ok(err.includes("LSP server not found for language: missing"));
});

test("LspRegistry: clearDiagnostics empties the list", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  reg.addDiagnostics("rust", [
    { path: "src/lib.rs", line: 1, character: 0, severity: "warning", message: "unused import", source: undefined },
  ]);
  assert.equal(reg.getDiagnostics("src/lib.rs").length, 1);
  const err = reg.clearDiagnostics("rust");
  assert.equal(err, undefined);
  assert.equal(reg.getDiagnostics("src/lib.rs").length, 0);
});

test("LspRegistry: clearDiagnostics returns error for unknown language", () => {
  const reg = new LspRegistry();
  const err = reg.clearDiagnostics("missing");
  assert.ok(typeof err === "string");
  assert.ok(err.includes("LSP server not found for language: missing"));
});

test("LspRegistry: getDiagnostics aggregates across servers for same path", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  reg.register("python", { kind: "connected" }, undefined, []);
  const sharedPath = "shared/file.txt";
  reg.addDiagnostics("rust", [
    { path: sharedPath, line: 4, character: 1, severity: "warning", message: "warn", source: undefined },
  ]);
  reg.addDiagnostics("python", [
    { path: sharedPath, line: 8, character: 3, severity: "error", message: "err", source: undefined },
  ]);
  const diags = reg.getDiagnostics(sharedPath);
  assert.equal(diags.length, 2);
  assert.ok(diags.some((d) => d.message === "warn"));
  assert.ok(diags.some((d) => d.message === "err"));
});

// ---------------------------------------------------------------------------
// LspRegistry — disconnect
// ---------------------------------------------------------------------------

test("LspRegistry: disconnect removes and returns server state", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  assert.equal(reg.size, 1);
  const removed = reg.disconnect("rust");
  assert.ok(removed !== undefined);
  assert.equal(removed.language, "rust");
  assert.ok(reg.isEmpty);
});

test("LspRegistry: disconnect on missing language returns undefined", () => {
  const reg = new LspRegistry();
  assert.equal(reg.disconnect("missing"), undefined);
});

// ---------------------------------------------------------------------------
// LspRegistry — dispatch
// ---------------------------------------------------------------------------

test("LspRegistry: dispatch diagnostics with path returns filtered list", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  reg.addDiagnostics("rust", [
    { path: "src/lib.rs", line: 1, character: 0, severity: "warning", message: "unused import", source: undefined },
  ]);
  const result = reg.dispatch("diagnostics", "src/lib.rs", undefined, undefined, undefined);
  assert.ok(result.ok);
  assert.equal(result.value.count, 1);
  assert.equal(result.value.action, "diagnostics");
});

test("LspRegistry: dispatch diagnostics without path aggregates all", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  reg.register("python", { kind: "connected" }, undefined, []);
  reg.addDiagnostics("rust", [
    { path: "a.rs", line: 1, character: 0, severity: "error", message: "e1", source: undefined },
  ]);
  reg.addDiagnostics("python", [
    { path: "b.py", line: 2, character: 0, severity: "error", message: "e2", source: undefined },
  ]);
  const result = reg.dispatch("diagnostics", undefined, undefined, undefined, undefined);
  assert.ok(result.ok);
  assert.equal(result.value.count, 2);
});

test("LspRegistry: dispatch hover on connected server succeeds", () => {
  const reg = new LspRegistry();
  reg.register("rust", { kind: "connected" }, undefined, []);
  const result = reg.dispatch("hover", "src/main.rs", 10, 5, undefined);
  assert.ok(result.ok);
  assert.equal(result.value.action, "hover");
  assert.equal(result.value.language, "rust");
});

test("LspRegistry: dispatch unknown action returns error", () => {
  const reg = new LspRegistry();
  const result = reg.dispatch("unknown_action", "file.rs", undefined, undefined, undefined);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("unknown LSP action: unknown_action"));
});

test("LspRegistry: dispatch non-diagnostics without path returns error", () => {
  const reg = new LspRegistry();
  const result = reg.dispatch("hover", undefined, 1, 0, undefined);
  assert.ok(!result.ok);
  assert.equal(result.error, "path is required for this LSP action");
});

test("LspRegistry: dispatch when no server for path returns error", () => {
  const reg = new LspRegistry();
  const result = reg.dispatch("hover", "notes.md", 1, 0, undefined);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("no LSP server available for path: notes.md"));
});

test("LspRegistry: dispatch on disconnected server returns error", () => {
  const reg = new LspRegistry();
  reg.register("typescript", { kind: "disconnected" }, undefined, []);
  const result = reg.dispatch("hover", "src/index.ts", 3, 2, undefined);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("typescript"));
  assert.ok(result.error.includes("disconnected"));
});
