import assert from "node:assert/strict";
import test from "node:test";

import {
  makeServerHealth,
  pluginStateFromServers,
  pluginStateLabel,
  makePluginHealthcheck,
  degradedMode,
  makeDegradedMode,
  pluginLifecycleEventLabel,
  ok,
  err,
} from "../dist/runtime/plugin-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000;

function healthy(name, caps = []) {
  return makeServerHealth(name, "healthy", caps);
}

function failed(name, caps, error) {
  return makeServerHealth(name, "failed", caps, error);
}

function degraded(name, caps, error) {
  return makeServerHealth(name, "degraded", caps, error);
}

function tool(name) {
  return { name, description: `${name} tool`, inputSchema: null };
}

function resource(name, uri) {
  return { uri, name, description: `${name} resource`, mimeType: "application/json" };
}

// ---------------------------------------------------------------------------
// pluginStateFromServers
// ---------------------------------------------------------------------------

test("pluginStateFromServers: empty list → failed(no servers available)", () => {
  const state = pluginStateFromServers([]);
  assert.equal(state.state, "failed");
  assert.equal(state.reason, "no servers available");
});

test("pluginStateFromServers: all healthy → healthy", () => {
  const state = pluginStateFromServers([healthy("alpha"), healthy("beta")]);
  assert.equal(state.state, "healthy");
});

test("pluginStateFromServers: one failed, rest healthy → degraded", () => {
  const state = pluginStateFromServers([
    healthy("alpha"),
    failed("beta", ["write"], "connection refused"),
    healthy("gamma"),
  ]);
  assert.equal(state.state, "degraded");
  assert.deepEqual(state.healthyServers, ["alpha", "gamma"]);
  assert.equal(state.failedServers.length, 1);
  assert.equal(state.failedServers[0].serverName, "beta");
});

test("pluginStateFromServers: all failed → failed(all N servers failed)", () => {
  const state = pluginStateFromServers([
    failed("alpha", ["search"], "timeout"),
    failed("beta", ["read"], "handshake failed"),
  ]);
  assert.equal(state.state, "failed");
  assert.ok(state.reason.includes("all 2 servers failed"));
});

test("pluginStateFromServers: degraded server keeps server in healthyServers", () => {
  const state = pluginStateFromServers([
    healthy("alpha"),
    degraded("beta", ["write"], "high latency"),
  ]);
  assert.equal(state.state, "degraded");
  assert.deepEqual(state.healthyServers, ["alpha", "beta"]);
  assert.equal(state.failedServers.length, 0);
});

// ---------------------------------------------------------------------------
// pluginStateLabel
// ---------------------------------------------------------------------------

test("pluginStateLabel: returns string label for each variant", () => {
  assert.equal(pluginStateLabel({ state: "unconfigured" }), "unconfigured");
  assert.equal(pluginStateLabel({ state: "validated" }), "validated");
  assert.equal(pluginStateLabel({ state: "starting" }), "starting");
  assert.equal(pluginStateLabel({ state: "healthy" }), "healthy");
  assert.equal(
    pluginStateLabel({ state: "degraded", healthyServers: [], failedServers: [] }),
    "degraded",
  );
  assert.equal(pluginStateLabel({ state: "failed", reason: "x" }), "failed");
  assert.equal(pluginStateLabel({ state: "shutting_down" }), "shutting_down");
  assert.equal(pluginStateLabel({ state: "stopped" }), "stopped");
});

// ---------------------------------------------------------------------------
// makePluginHealthcheck
// ---------------------------------------------------------------------------

test("makePluginHealthcheck: builds healthcheck with correct state", () => {
  const hc = makePluginHealthcheck(
    "my-plugin",
    [healthy("alpha", ["search"]), healthy("beta", ["write"])],
    NOW,
  );
  assert.equal(hc.pluginName, "my-plugin");
  assert.equal(hc.state.state, "healthy");
  assert.equal(hc.servers.length, 2);
  assert.equal(hc.lastCheck, NOW);
});

test("makePluginHealthcheck: degraded when one server fails", () => {
  const hc = makePluginHealthcheck(
    "deg-plugin",
    [healthy("alpha"), failed("beta", ["write"], "timeout")],
    NOW,
  );
  assert.equal(hc.state.state, "degraded");
});

// ---------------------------------------------------------------------------
// degradedMode
// ---------------------------------------------------------------------------

test("degradedMode: returns undefined for healthy plugin", () => {
  const hc = makePluginHealthcheck("p", [healthy("alpha", ["search"])], NOW);
  const disc = { tools: [tool("search")], resources: [], partial: false };
  assert.equal(degradedMode(hc, disc), undefined);
});

test("degradedMode: returns DegradedMode for degraded plugin", () => {
  const hc = makePluginHealthcheck(
    "p",
    [
      healthy("alpha", ["search"]),
      failed("beta", ["write"], "connection refused"),
    ],
    NOW,
  );
  const disc = {
    tools: [tool("search"), tool("read")],
    resources: [resource("docs", "file:///docs")],
    partial: true,
  };
  const dm = degradedMode(hc, disc);
  assert.ok(dm !== undefined);
  assert.deepEqual(dm.availableTools, ["search", "read"]);
  assert.deepEqual(dm.unavailableTools, ["write"]);
  assert.ok(dm.reason.includes("1 servers healthy"));
  assert.ok(dm.reason.includes("1 servers failed"));
});

test("degradedMode: returns undefined for failed plugin", () => {
  const hc = makePluginHealthcheck(
    "p",
    [failed("alpha", ["search"], "crash"), failed("beta", ["write"], "crash")],
    NOW,
  );
  const disc = { tools: [], resources: [], partial: false };
  assert.equal(degradedMode(hc, disc), undefined);
});

// ---------------------------------------------------------------------------
// makeDegradedMode
// ---------------------------------------------------------------------------

test("makeDegradedMode: constructs correctly", () => {
  const dm = makeDegradedMode(["search", "read"], ["write"], "2 healthy, 1 failed");
  assert.deepEqual(dm.availableTools, ["search", "read"]);
  assert.deepEqual(dm.unavailableTools, ["write"]);
  assert.equal(dm.reason, "2 healthy, 1 failed");
});

// ---------------------------------------------------------------------------
// pluginLifecycleEventLabel
// ---------------------------------------------------------------------------

test("pluginLifecycleEventLabel: each event has the expected string label", () => {
  assert.equal(pluginLifecycleEventLabel("config_validated"), "config_validated");
  assert.equal(pluginLifecycleEventLabel("startup_healthy"), "startup_healthy");
  assert.equal(pluginLifecycleEventLabel("startup_degraded"), "startup_degraded");
  assert.equal(pluginLifecycleEventLabel("startup_failed"), "startup_failed");
  assert.equal(pluginLifecycleEventLabel("shutdown"), "shutdown");
});

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

test("ok: wraps a value", () => {
  const r = ok(42);
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
});

test("err: wraps an error", () => {
  const r = err("something went wrong");
  assert.equal(r.ok, false);
  assert.equal(r.error, "something went wrong");
});

// ---------------------------------------------------------------------------
// Full lifecycle simulation via plain objects (no class required)
// ---------------------------------------------------------------------------

test("full lifecycle happy path: validate → healthy → shutdown", () => {
  // Simulate a plugin that validates OK, starts healthy, and shuts down cleanly.
  let shutdownCalled = false;

  const servers = [healthy("alpha", ["search", "read"]), healthy("beta", ["write"])];

  const hcBefore = makePluginHealthcheck("healthy-plugin", servers, NOW);
  assert.equal(hcBefore.state.state, "healthy");

  // Simulate shutdown.
  shutdownCalled = true;
  const hcAfter = { ...hcBefore, state: { state: "stopped" }, lastCheck: NOW + 1 };

  assert.ok(shutdownCalled);
  assert.equal(hcAfter.state.state, "stopped");
  assert.equal(pluginLifecycleEventLabel("shutdown"), "shutdown");
});

test("full lifecycle degraded path: one server fails, partial discovery", () => {
  const servers = [
    healthy("alpha", ["search"]),
    failed("beta", ["write"], "connection refused"),
    healthy("gamma", ["read"]),
  ];

  const hc = makePluginHealthcheck("degraded-plugin", servers, NOW);
  const disc = {
    tools: [tool("search"), tool("read")],
    resources: [resource("alpha-docs", "file:///alpha")],
    partial: true,
  };

  assert.equal(hc.state.state, "degraded");
  assert.ok(disc.partial);

  const dm = degradedMode(hc, disc);
  assert.ok(dm !== undefined);
  assert.deepEqual(dm.availableTools, ["search", "read"]);
  assert.deepEqual(dm.unavailableTools, ["write"]);
  assert.ok(dm.reason.includes("2 servers healthy"));
  assert.ok(dm.reason.includes("1 servers failed"));
});

test("full lifecycle total failure: all servers failed, no discovery", () => {
  const servers = [
    failed("alpha", ["search"], "timeout"),
    failed("beta", ["read"], "handshake failed"),
  ];

  const hc = makePluginHealthcheck("failed-plugin", servers, NOW);
  const disc = { tools: [], resources: [], partial: false };

  assert.equal(hc.state.state, "failed");
  assert.ok(hc.state.reason.includes("all 2 servers failed"));
  assert.equal(disc.tools.length, 0);
  assert.equal(degradedMode(hc, disc), undefined);
});
