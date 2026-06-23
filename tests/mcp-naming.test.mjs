import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNameForMcp,
  mcpToolPrefix,
  mcpToolName,
  mcpServerSignature,
  stableHexHash,
} from "../dist/runtime/mcp/naming.js";

// ---------------------------------------------------------------------------
// normalizeNameForMcp
// ---------------------------------------------------------------------------

test("normalizeNameForMcp replaces disallowed chars with underscore", () => {
  assert.equal(normalizeNameForMcp("github.com"), "github_com");
  assert.equal(normalizeNameForMcp("tool name!"), "tool_name_");
});

test("normalizeNameForMcp keeps allowed chars (letters, digits, _ and -)", () => {
  assert.equal(normalizeNameForMcp("Server-1_x"), "Server-1_x");
});

test("normalizeNameForMcp collapses and trims underscores only for the vendor prefix", () => {
  assert.equal(normalizeNameForMcp("claude.ai Example   Server!!"), "claude_ai_Example_Server");
  // Without the prefix, runs of underscores are preserved.
  assert.equal(normalizeNameForMcp("a   b"), "a___b");
});

// ---------------------------------------------------------------------------
// mcpToolPrefix / mcpToolName
// ---------------------------------------------------------------------------

test("mcpToolPrefix wraps the normalized server name", () => {
  assert.equal(mcpToolPrefix("github.com"), "mcp__github_com__");
});

test("mcpToolName joins normalized server and tool names", () => {
  assert.equal(
    mcpToolName("claude.ai Example Server", "weather tool"),
    "mcp__claude_ai_Example_Server__weather_tool",
  );
  assert.equal(mcpToolName("stdio-server", "echo"), "mcp__stdio-server__echo");
});

// ---------------------------------------------------------------------------
// mcpServerSignature
// ---------------------------------------------------------------------------

test("mcpServerSignature renders stdio command vectors", () => {
  assert.equal(
    mcpServerSignature({ kind: "stdio", command: "uvx", args: ["mcp-server"] }),
    "stdio:[uvx|mcp-server]",
  );
  assert.equal(mcpServerSignature({ kind: "stdio", command: "node" }), "stdio:[node]");
});

test("mcpServerSignature escapes pipes and backslashes in command parts", () => {
  assert.equal(
    mcpServerSignature({ kind: "stdio", command: "a|b", args: ["c\\d"] }),
    "stdio:[a\\|b|c\\\\d]",
  );
});

test("mcpServerSignature renders url targets verbatim (no proxy unwrapping)", () => {
  assert.equal(
    mcpServerSignature({ kind: "url", url: "https://vendor.example/mcp?mcp_url=x" }),
    "url:https://vendor.example/mcp?mcp_url=x",
  );
});

// ---------------------------------------------------------------------------
// stableHexHash
// ---------------------------------------------------------------------------

test("stableHexHash is deterministic and 16 hex chars wide", () => {
  const a = stableHexHash("hello");
  const b = stableHexHash("hello");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(stableHexHash("hello"), stableHexHash("world"));
});

test("stableHexHash matches the FNV-1a offset basis for the empty string", () => {
  // FNV-1a 64-bit offset basis with no bytes mixed in.
  assert.equal(stableHexHash(""), "cbf29ce484222325");
});
