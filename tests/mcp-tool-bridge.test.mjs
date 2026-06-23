import assert from "node:assert/strict";
import test from "node:test";

import {
  toToolInfo,
  toResourceInfo,
  bridgeTool,
  bridgeTools,
} from "../dist/runtime/mcp/tool-bridge.js";

// ---------------------------------------------------------------------------
// toToolInfo / toResourceInfo
// ---------------------------------------------------------------------------

test("toToolInfo carries name, description and inputSchema through", () => {
  const info = toToolInfo({
    name: "echo",
    description: "Echoes text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  });
  assert.deepEqual(info, {
    name: "echo",
    description: "Echoes text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  });
});

test("toResourceInfo falls back to the uri when name is absent", () => {
  const named = toResourceInfo({ uri: "file://guide.txt", name: "guide", mimeType: "text/plain" });
  assert.equal(named.name, "guide");
  assert.equal(named.mimeType, "text/plain");

  const unnamed = toResourceInfo({ uri: "file://anon.txt" });
  assert.equal(unnamed.name, "file://anon.txt");
  assert.equal(unnamed.description, undefined);
});

// ---------------------------------------------------------------------------
// bridgeTool / bridgeTools
// ---------------------------------------------------------------------------

test("bridgeTool produces a namespace-qualified spec preserving routing info", () => {
  const spec = bridgeTool("github.com", {
    name: "search",
    description: "Search repos",
    inputSchema: { type: "object" },
  });
  assert.equal(spec.qualifiedName, "mcp__github_com__search");
  assert.equal(spec.serverName, "github.com");
  assert.equal(spec.rawName, "search");
  assert.equal(spec.description, "Search repos");
  assert.deepEqual(spec.inputSchema, { type: "object" });
});

test("bridgeTools maps a full tools/list payload", () => {
  const specs = bridgeTools("alpha", [
    { name: "echo", description: "Echo" },
    { name: "weather tool" },
  ]);
  assert.deepEqual(
    specs.map((s) => s.qualifiedName),
    ["mcp__alpha__echo", "mcp__alpha__weather_tool"],
  );
  // raw names are retained verbatim for tools/call dispatch.
  assert.deepEqual(specs.map((s) => s.rawName), ["echo", "weather tool"]);
});

test("bridgeTools returns an empty array for a server with no tools", () => {
  assert.deepEqual(bridgeTools("empty", []), []);
});

test("bridged qualified names cannot collide with un-namespaced built-in tools", () => {
  const spec = bridgeTool("srv", { name: "read_file" });
  assert.equal(spec.qualifiedName, "mcp__srv__read_file");
  assert.notEqual(spec.qualifiedName, "read_file");
});
