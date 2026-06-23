import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_LIFECYCLE_PHASES,
  McpLifecycleValidator,
  validatePhaseTransition,
  makeErrorSurface,
  renderErrorSurface,
  buildDegradedReport,
} from "../dist/runtime/mcp/lifecycle.js";

// ---------------------------------------------------------------------------
// transition table
// ---------------------------------------------------------------------------

test("validatePhaseTransition accepts the canonical startup path", () => {
  const valid = [
    ["config_load", "server_registration"],
    ["server_registration", "spawn_connect"],
    ["spawn_connect", "initialize_handshake"],
    ["initialize_handshake", "tool_discovery"],
    ["tool_discovery", "resource_discovery"],
    ["tool_discovery", "ready"],
    ["resource_discovery", "ready"],
    ["ready", "invocation"],
    ["invocation", "ready"],
    ["ready", "shutdown"],
    ["invocation", "error_surfacing"],
    ["error_surfacing", "shutdown"],
    ["shutdown", "cleanup"],
  ];
  for (const [from, to] of valid) {
    assert.ok(validatePhaseTransition(from, to), `${from} -> ${to} should be valid`);
  }
});

test("validatePhaseTransition rejects illegal transitions", () => {
  assert.ok(!validatePhaseTransition("ready", "config_load"));
  assert.ok(!validatePhaseTransition("cleanup", "ready"));
  assert.ok(!validatePhaseTransition("cleanup", "shutdown"));
  assert.ok(!validatePhaseTransition("shutdown", "error_surfacing"));
});

// ---------------------------------------------------------------------------
// validator phase walk
// ---------------------------------------------------------------------------

test("validator walks the full startup-to-cleanup path with all successes", () => {
  const validator = new McpLifecycleValidator();
  const path = [
    "config_load",
    "server_registration",
    "spawn_connect",
    "initialize_handshake",
    "tool_discovery",
    "resource_discovery",
    "ready",
    "invocation",
    "ready",
    "shutdown",
    "cleanup",
  ];
  const results = path.map((phase) => validator.runPhase(phase));
  assert.ok(results.every((r) => r.kind === "success"));
  assert.equal(validator.currentPhase(), "cleanup");
});

test("validator allows skipping resource_discovery straight to ready", () => {
  const validator = new McpLifecycleValidator();
  for (const phase of ["config_load", "server_registration", "spawn_connect", "initialize_handshake", "tool_discovery"]) {
    assert.equal(validator.runPhase(phase).kind, "success");
  }
  assert.equal(validator.runPhase("ready").kind, "success");
  assert.equal(validator.currentPhase(), "ready");
});

test("validator rejects an invalid initial phase", () => {
  const validator = new McpLifecycleValidator();
  const result = validator.runPhase("ready");
  assert.equal(result.kind, "failure");
  assert.equal(validator.currentPhase(), "error_surfacing");
});

test("validator records a structured failure for an illegal transition", () => {
  const validator = new McpLifecycleValidator();
  validator.runPhase("config_load");
  validator.runPhase("server_registration");
  const result = validator.runPhase("ready");
  assert.equal(result.kind, "failure");
  assert.equal(result.error.recoverable, false);
  assert.equal(result.error.context.from, "server_registration");
  assert.equal(result.error.context.to, "ready");
  assert.equal(validator.errorsForPhase("ready").length, 1);
});

test("validator preserves the waited duration on a timeout", () => {
  const validator = new McpLifecycleValidator();
  const result = validator.recordTimeout("spawn_connect", 250, { serverName: "alpha", context: { attempt: "1" } });
  assert.equal(result.kind, "timeout");
  assert.equal(result.waitedMs, 250);
  assert.equal(result.error.recoverable, true);
  assert.equal(result.error.serverName, "alpha");
  assert.equal(validator.errorsForPhase("spawn_connect")[0].context.waited_ms, "250");
  assert.equal(validator.currentPhase(), "error_surfacing");
});

test("validator blocks resume after a non-recoverable failure but allows it after a recoverable one", () => {
  const base = ["config_load", "server_registration", "spawn_connect", "initialize_handshake", "tool_discovery", "ready"];

  const blocked = new McpLifecycleValidator();
  base.forEach((p) => blocked.runPhase(p));
  blocked.recordFailure(makeErrorSurface("invocation", "corrupted session", { recoverable: false }));
  const blockedResume = blocked.runPhase("ready");
  assert.equal(blockedResume.kind, "failure");
  assert.match(blockedResume.error.message, /non-recoverable/);

  const allowed = new McpLifecycleValidator();
  base.forEach((p) => allowed.runPhase(p));
  allowed.recordFailure(makeErrorSurface("invocation", "retryable", { recoverable: true }));
  assert.equal(allowed.runPhase("ready").kind, "success");
});

// ---------------------------------------------------------------------------
// error surface rendering
// ---------------------------------------------------------------------------

test("renderErrorSurface includes phase, server, context and recoverable flag", () => {
  const error = makeErrorSurface("spawn_connect", "process exited early", {
    serverName: "alpha",
    context: { exit_code: "1" },
    recoverable: true,
  });
  const rendered = renderErrorSurface(error);
  assert.match(rendered, /spawn_connect/);
  assert.match(rendered, /process exited early/);
  assert.match(rendered, /server: alpha/);
  assert.match(rendered, /recoverable/);
});

// ---------------------------------------------------------------------------
// degraded report
// ---------------------------------------------------------------------------

test("buildDegradedReport dedupes, sorts, and computes missing tools", () => {
  const failed = [
    {
      serverName: "broken",
      phase: "initialize_handshake",
      error: makeErrorSurface("initialize_handshake", "initialize failed", { serverName: "broken" }),
    },
  ];
  const report = buildDegradedReport(
    ["alpha", "beta", "alpha"],
    failed,
    ["alpha.echo", "beta.search", "alpha.echo"],
    ["alpha.echo", "beta.search", "broken.fetch"],
  );
  assert.deepEqual(report.workingServers, ["alpha", "beta"]);
  assert.deepEqual(report.availableTools, ["alpha.echo", "beta.search"]);
  assert.deepEqual(report.missingTools, ["broken.fetch"]);
  assert.equal(report.failedServers[0].serverName, "broken");
});

test("MCP_LIFECYCLE_PHASES lists all eleven phases in order", () => {
  assert.equal(MCP_LIFECYCLE_PHASES.length, 11);
  assert.equal(MCP_LIFECYCLE_PHASES[0], "config_load");
  assert.equal(MCP_LIFECYCLE_PHASES[MCP_LIFECYCLE_PHASES.length - 1], "cleanup");
});
