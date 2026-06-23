import assert from "node:assert/strict";
import test from "node:test";

import { PluginRegistry, PluginManager } from "../dist/plugins/manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides = {}) {
  return {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    permissions: [],
    defaultEnabled: false,
    hooks: { PreToolUse: [], PostToolUse: [], PostToolUseFailure: [] },
    lifecycle: { Init: [], Shutdown: [] },
    tools: [],
    commands: [],
    ...overrides,
  };
}

const builtinKind = { kind: "builtin" };
const bundledKind = { kind: "bundled" };
const externalKind = { kind: "external" };

// ---------------------------------------------------------------------------
// PluginRegistry — registration
// ---------------------------------------------------------------------------

test("PluginRegistry: register adds a plugin", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0].metadata.name, "test-plugin");
});

test("PluginRegistry: register throws on duplicate id", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  assert.throws(
    () => reg.register(makeManifest(), builtinKind, "builtin"),
    /already registered/,
  );
});

test("PluginRegistry: has returns true for registered plugin", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  assert.equal(reg.has("builtin:test-plugin"), true);
});

test("PluginRegistry: has returns false for unknown plugin", () => {
  const reg = new PluginRegistry();
  assert.equal(reg.has("builtin:does-not-exist"), false);
});

test("PluginRegistry: get returns the entry", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  const entry = reg.get("builtin:test-plugin");
  assert.ok(entry !== undefined);
  assert.equal(entry.metadata.id, "builtin:test-plugin");
});

// ---------------------------------------------------------------------------
// Default enabled logic
// ---------------------------------------------------------------------------

test("PluginRegistry: builtin with defaultEnabled=true is enabled by default", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ defaultEnabled: true }), builtinKind, "builtin");
  assert.equal(reg.list()[0].enabled, true);
});

test("PluginRegistry: builtin with defaultEnabled=false is disabled by default", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ defaultEnabled: false }), builtinKind, "builtin");
  assert.equal(reg.list()[0].enabled, false);
});

test("PluginRegistry: external plugin is always disabled by default regardless of defaultEnabled", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ defaultEnabled: true }), externalKind, "/path/to/plugin");
  assert.equal(reg.list()[0].enabled, false);
});

test("PluginRegistry: bundled with defaultEnabled=true is enabled by default", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ defaultEnabled: true }), bundledKind, "bundled");
  assert.equal(reg.list()[0].enabled, true);
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

test("PluginRegistry: enable sets enabled=true", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  reg.enable("builtin:test-plugin");
  assert.equal(reg.list()[0].enabled, true);
});

test("PluginRegistry: disable sets enabled=false", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ defaultEnabled: true }), builtinKind, "builtin");
  reg.disable("builtin:test-plugin");
  assert.equal(reg.list()[0].enabled, false);
});

test("PluginRegistry: enable throws for unknown plugin", () => {
  const reg = new PluginRegistry();
  assert.throws(() => reg.enable("builtin:missing"), /not registered/);
});

test("PluginRegistry: disable throws for unknown plugin", () => {
  const reg = new PluginRegistry();
  assert.throws(() => reg.disable("builtin:missing"), /not registered/);
});

// ---------------------------------------------------------------------------
// list / listEnabled
// ---------------------------------------------------------------------------

test("PluginRegistry: list returns all plugins regardless of enabled state", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ name: "p1", defaultEnabled: true }), builtinKind, "builtin");
  reg.register(makeManifest({ name: "p2", defaultEnabled: false }), builtinKind, "builtin");
  assert.equal(reg.list().length, 2);
});

test("PluginRegistry: listEnabled returns only enabled plugins", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest({ name: "p1", defaultEnabled: true }), builtinKind, "builtin");
  reg.register(makeManifest({ name: "p2", defaultEnabled: false }), builtinKind, "builtin");
  assert.equal(reg.listEnabled().length, 1);
  assert.equal(reg.listEnabled()[0].metadata.name, "p1");
});

// ---------------------------------------------------------------------------
// aggregatedHooks
// ---------------------------------------------------------------------------

test("aggregatedHooks: empty registry returns empty hook config", () => {
  const reg = new PluginRegistry();
  const hooks = reg.aggregatedHooks();
  assert.deepEqual(hooks.PreToolUse, []);
  assert.deepEqual(hooks.PostToolUse, []);
  assert.deepEqual(hooks.PostToolUseFailure, []);
});

test("aggregatedHooks: merges hooks from all enabled plugins in order", () => {
  const reg = new PluginRegistry();
  reg.register(
    makeManifest({
      name: "p1",
      defaultEnabled: true,
      hooks: { PreToolUse: ["pre-a.sh"], PostToolUse: ["post-a.sh"], PostToolUseFailure: [] },
    }),
    builtinKind,
    "builtin",
  );
  reg.register(
    makeManifest({
      name: "p2",
      defaultEnabled: true,
      hooks: { PreToolUse: ["pre-b.sh"], PostToolUse: [], PostToolUseFailure: ["fail-b.sh"] },
    }),
    builtinKind,
    "builtin",
  );
  const hooks = reg.aggregatedHooks();
  assert.deepEqual(hooks.PreToolUse, ["pre-a.sh", "pre-b.sh"]);
  assert.deepEqual(hooks.PostToolUse, ["post-a.sh"]);
  assert.deepEqual(hooks.PostToolUseFailure, ["fail-b.sh"]);
});

test("aggregatedHooks: skips hooks from disabled plugins", () => {
  const reg = new PluginRegistry();
  reg.register(
    makeManifest({
      name: "p1",
      defaultEnabled: false,
      hooks: { PreToolUse: ["hidden.sh"], PostToolUse: [], PostToolUseFailure: [] },
    }),
    builtinKind,
    "builtin",
  );
  const hooks = reg.aggregatedHooks();
  assert.deepEqual(hooks.PreToolUse, []);
});

// ---------------------------------------------------------------------------
// aggregatedTools
// ---------------------------------------------------------------------------

test("aggregatedTools: returns empty array when no enabled plugins have tools", () => {
  const reg = new PluginRegistry();
  reg.register(makeManifest(), builtinKind, "builtin");
  assert.deepEqual(reg.aggregatedTools(), []);
});

test("aggregatedTools: collects tools from enabled plugins", () => {
  const reg = new PluginRegistry();
  reg.register(
    makeManifest({
      name: "p1",
      defaultEnabled: true,
      tools: [
        {
          name: "tool-a",
          description: "Tool A",
          inputSchema: { type: "object" },
          command: "node",
          args: ["a.js"],
          requiredPermission: "read-only",
        },
      ],
    }),
    builtinKind,
    "builtin",
  );
  const tools = reg.aggregatedTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "tool-a");
  assert.equal(tools[0].pluginId, "builtin:p1");
  assert.equal(tools[0].pluginName, "p1");
  assert.equal(tools[0].requiredPermission, "read-only");
});

test("aggregatedTools: merges tools from multiple enabled plugins", () => {
  const reg = new PluginRegistry();
  const toolEntry = (name) => ({
    name,
    description: `${name} desc`,
    inputSchema: {},
    command: "cmd",
    args: [],
    requiredPermission: "read-only",
  });
  reg.register(
    makeManifest({ name: "p1", defaultEnabled: true, tools: [toolEntry("tool-a")] }),
    builtinKind,
    "builtin",
  );
  reg.register(
    makeManifest({ name: "p2", defaultEnabled: true, tools: [toolEntry("tool-b")] }),
    builtinKind,
    "builtin",
  );
  const tools = reg.aggregatedTools();
  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["tool-a", "tool-b"]);
});

test("aggregatedTools: skips tools from disabled plugins", () => {
  const reg = new PluginRegistry();
  reg.register(
    makeManifest({
      name: "p1",
      defaultEnabled: false,
      tools: [
        { name: "hidden", description: "d", inputSchema: {}, command: "c", args: [], requiredPermission: "read-only" },
      ],
    }),
    builtinKind,
    "builtin",
  );
  assert.deepEqual(reg.aggregatedTools(), []);
});

test("aggregatedTools: throws on duplicate tool name across enabled plugins", () => {
  const reg = new PluginRegistry();
  const sameTool = { name: "clash", description: "d", inputSchema: {}, command: "c", args: [], requiredPermission: "read-only" };
  reg.register(
    makeManifest({ name: "p1", defaultEnabled: true, tools: [sameTool] }),
    builtinKind,
    "builtin",
  );
  reg.register(
    makeManifest({ name: "p2", defaultEnabled: true, tools: [sameTool] }),
    builtinKind,
    "builtin",
  );
  assert.throws(() => reg.aggregatedTools(), /clash/);
});

// ---------------------------------------------------------------------------
// PluginManager — load from injected source
// ---------------------------------------------------------------------------

test("PluginManager: load from injected source registers plugins", () => {
  const mgr = new PluginManager();
  const source = () => [
    { manifest: makeManifest({ name: "alpha" }), kind: builtinKind, source: "builtin" },
    { manifest: makeManifest({ name: "beta" }), kind: bundledKind, source: "bundled" },
  ];
  const result = mgr.load(source);
  assert.equal(result.loaded, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(mgr.list().length, 2);
});

test("PluginManager: load collects errors without throwing", () => {
  const mgr = new PluginManager();
  const source = () => [
    { manifest: makeManifest({ name: "dup" }), kind: builtinKind, source: "builtin" },
    { manifest: makeManifest({ name: "dup" }), kind: builtinKind, source: "builtin" }, // duplicate
  ];
  const result = mgr.load(source);
  assert.equal(result.loaded, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].error.includes("already registered"));
});

test("PluginManager: enable/disable round-trips through registry", () => {
  const mgr = new PluginManager();
  mgr.load(() => [{ manifest: makeManifest({ name: "p1" }), kind: builtinKind, source: "builtin" }]);
  mgr.enable("builtin:p1");
  assert.equal(mgr.list()[0].enabled, true);
  mgr.disable("builtin:p1");
  assert.equal(mgr.list()[0].enabled, false);
});

test("PluginManager: aggregatedHooks and aggregatedTools delegate to registry", () => {
  const mgr = new PluginManager();
  mgr.load(() => [
    {
      manifest: makeManifest({
        name: "p1",
        defaultEnabled: true,
        hooks: { PreToolUse: ["hook.sh"], PostToolUse: [], PostToolUseFailure: [] },
        tools: [
          { name: "my-tool", description: "d", inputSchema: {}, command: "c", args: [], requiredPermission: "read-only" },
        ],
      }),
      kind: builtinKind,
      source: "builtin",
    },
  ]);
  const hooks = mgr.aggregatedHooks();
  assert.deepEqual(hooks.PreToolUse, ["hook.sh"]);
  const tools = mgr.aggregatedTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "my-tool");
});

test("PluginManager: getRegistry returns the underlying PluginRegistry", () => {
  const mgr = new PluginManager();
  const reg = mgr.getRegistry();
  assert.ok(reg instanceof PluginRegistry);
});
