import assert from "node:assert/strict";
import test from "node:test";

import { formatMcpToolResult, mcpToolsAsRuntimeTools } from "../dist/tools/mcp-tools.js";
import { parseMcpServers, buildMcpManager } from "../dist/runtime/mcp/config.js";

const SPEC = {
  qualifiedName: "mcp__files__read",
  serverName: "files",
  rawName: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

test("formatMcpToolResult joins text blocks", () => {
  assert.equal(formatMcpToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
});

test("formatMcpToolResult prefixes ERROR on isError", () => {
  assert.equal(formatMcpToolResult({ content: [{ type: "text", text: "boom" }], isError: true }), "ERROR: boom");
});

test("formatMcpToolResult handles empty content", () => {
  assert.equal(formatMcpToolResult({ content: [] }), "(no content)");
  assert.equal(formatMcpToolResult({}), "(no content)");
});

test("mcpToolsAsRuntimeTools builds a registry-shaped tool that routes to invoke", async () => {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "file contents" }] };
  };
  const tools = mcpToolsAsRuntimeTools([SPEC], invoke);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].spec.name, "mcp__files__read");
  assert.equal(tools[0].spec.requiredPermission, "workspace-write");
  assert.equal(tools[0].spec.description, "Read a file");

  const result = await tools[0].execute({ path: "README.md" });
  assert.equal(result.toolName, "mcp__files__read");
  assert.equal(result.content, "file contents");
  assert.deepEqual(calls, [{ name: "mcp__files__read", args: { path: "README.md" } }]);
});

test("mcpToolsAsRuntimeTools surfaces invocation failures as ERROR output", async () => {
  const invoke = async () => {
    throw new Error("server crashed");
  };
  const tools = mcpToolsAsRuntimeTools([SPEC], invoke);
  const result = await tools[0].execute({});
  assert.match(result.content, /^ERROR: server crashed$/);
});

test("mcpToolsAsRuntimeTools defaults a permissive schema when none advertised", () => {
  const tools = mcpToolsAsRuntimeTools([{ qualifiedName: "mcp__x__y", serverName: "x", rawName: "y" }], async () => ({}));
  assert.equal(tools[0].spec.inputSchema.type, "object");
});

test("parseMcpServers reads a flat map and an mcpServers wrapper", () => {
  const flat = parseMcpServers(JSON.stringify({ files: { command: "node", args: ["server.js"] } }));
  assert.deepEqual(flat, { files: { command: "node", args: ["server.js"] } });

  const wrapped = parseMcpServers(JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
  assert.deepEqual(wrapped, { db: { command: "db-mcp" } });
});

test("parseMcpServers ignores invalid entries and malformed JSON", () => {
  assert.deepEqual(parseMcpServers("not json"), {});
  assert.deepEqual(parseMcpServers(JSON.stringify({ bad: { args: ["x"] } })), {}); // no command
});

test("buildMcpManager registers a server per config via an injected factory", () => {
  const built = [];
  const factory = (descriptor) => {
    built.push(descriptor);
    return { send: async () => {}, onMessage: () => {}, close: () => {} };
  };
  const manager = buildMcpManager({ files: { command: "node", args: ["s.js"] }, db: { command: "db" } }, factory);
  assert.deepEqual(manager.serverNames().sort(), ["db", "files"]);
  assert.equal(built.length, 2);
  assert.equal(built[0].kind, "stdio");
});
