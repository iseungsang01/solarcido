import assert from "node:assert/strict";
import test from "node:test";

import { WorkerRegistry } from "../dist/runtime/worker-boot.js";

// ---------------------------------------------------------------------------
// Deterministic clock for tests
// ---------------------------------------------------------------------------

function makeClock() {
  let counter = 0;
  let ts = 1_700_000_000;
  return {
    nextId: () => ++counter,
    nowSecs: () => ts++,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readyRegistry() {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  reg.observe(worker.workerId, "Ready for input\n>");
  return { reg, workerId: worker.workerId };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: initial status is spawning", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-a", [], true);
  assert.equal(worker.status, "spawning");
  assert.ok(worker.workerId.startsWith("worker_"));
  assert.equal(worker.promptDeliveryAttempts, 0);
  assert.equal(worker.promptInFlight, false);
  assert.equal(worker.trustGateCleared, false);
  assert.equal(worker.events.length, 1);
  assert.equal(worker.events[0].kind, "spawning");
});

test("create: trust_auto_resolve set when cwd is under trusted root", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/worktrees/repo-a", ["/tmp/worktrees"], true);
  assert.equal(worker.trustAutoResolve, true);
});

test("create: trust_auto_resolve false when cwd not under any trusted root", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/other/repo", ["/tmp/worktrees"], true);
  assert.equal(worker.trustAutoResolve, false);
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

test("get: returns snapshot for known workerId", () => {
  const reg = new WorkerRegistry(makeClock());
  const w = reg.create("/tmp/x", [], true);
  const fetched = reg.get(w.workerId);
  assert.ok(fetched !== undefined);
  assert.equal(fetched.workerId, w.workerId);
});

test("get: returns undefined for unknown workerId", () => {
  const reg = new WorkerRegistry(makeClock());
  assert.equal(reg.get("nope"), undefined);
});

// ---------------------------------------------------------------------------
// observe — trust gate (auto-resolve)
// ---------------------------------------------------------------------------

test("observe: allowlisted trust prompt auto-resolves and stays spawning", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/worktrees/repo-a", ["/tmp/worktrees"], true);

  const after = reg.observe(
    worker.workerId,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );

  assert.equal(after.status, "spawning");
  assert.equal(after.trustGateCleared, true);
  assert.ok(after.events.some((e) => e.kind === "trust_required"));
  assert.ok(after.events.some((e) => e.kind === "trust_resolved"));

  const resolved = after.events.find((e) => e.kind === "trust_resolved");
  assert.equal(resolved?.payload?.type, "trust_prompt");
  assert.equal(resolved?.payload?.resolution, "auto_allowlisted");
});

test("observe: non-allowlisted trust prompt blocks worker at trust_required", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-b", [], true);

  const blocked = reg.observe(
    worker.workerId,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );

  assert.equal(blocked.status, "trust_required");
  assert.equal(blocked.lastError?.kind, "trust_gate");
  assert.equal(blocked.trustGateCleared, false);
});

// ---------------------------------------------------------------------------
// resolveTrust
// ---------------------------------------------------------------------------

test("resolveTrust: transitions trust_required → spawning and marks gate cleared", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-c", [], true);
  reg.observe(worker.workerId, "Do you trust the files in this folder?\n1. Yes, proceed");

  const resolved = reg.resolveTrust(worker.workerId);
  assert.equal(resolved.status, "spawning");
  assert.equal(resolved.trustGateCleared, true);
  assert.ok(resolved.lastError === undefined);

  const evt = resolved.events.find((e) => e.kind === "trust_resolved");
  assert.ok(evt !== undefined);
  assert.equal(evt.payload?.type, "trust_prompt");
  assert.equal(evt.payload?.resolution, "manual_approval");
});

test("resolveTrust: throws when worker is not in trust_required", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  assert.throws(() => reg.resolveTrust(worker.workerId), /not waiting on trust/);
});

// ---------------------------------------------------------------------------
// observe — ready_for_prompt detection
// ---------------------------------------------------------------------------

test("observe: ready detection on › prompt character", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  const after = reg.observe(worker.workerId, "Ready for your input\n>");
  assert.equal(after.status, "ready_for_prompt");
  assert.ok(after.events.some((e) => e.kind === "ready_for_prompt"));
});

test("observe: shell prompt $ does not trigger ready_for_prompt", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  const after = reg.observe(worker.workerId, "user@host /tmp/repo $");
  assert.notEqual(after.status, "ready_for_prompt");
});

test("observe: box prompt │ > triggers ready_for_prompt", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  const after = reg.observe(worker.workerId, "│ >");
  assert.equal(after.status, "ready_for_prompt");
});

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

test("sendPrompt: transitions to running and increments delivery attempts", () => {
  const { reg, workerId } = readyRegistry();
  const running = reg.sendPrompt(workerId, "Implement worker handshake", undefined);
  assert.equal(running.status, "running");
  assert.equal(running.promptDeliveryAttempts, 1);
  assert.equal(running.promptInFlight, true);
  assert.equal(running.lastPrompt, "Implement worker handshake");
});

test("sendPrompt: throws when not in ready_for_prompt", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], true);
  assert.throws(
    () => reg.sendPrompt(worker.workerId, "hello", undefined),
    /not ready for prompt delivery/,
  );
});

test("sendPrompt: replays from replayPrompt when prompt argument is empty", () => {
  const { reg, workerId } = readyRegistry();
  // Send a prompt that gets misdelivered.
  reg.sendPrompt(workerId, "Run the bootstrap tests", undefined);
  // Trigger misdelivery so replayPrompt gets set.
  reg.observe(workerId, "% Run the bootstrap tests\nzsh: command not found: Run");
  // Now replay with no explicit prompt.
  const replayed = reg.sendPrompt(workerId, undefined, undefined);
  assert.equal(replayed.status, "running");
  assert.equal(replayed.promptDeliveryAttempts, 2);
  assert.equal(replayed.replayPrompt, undefined);
});

test("sendPrompt: throws when no prompt and no replay buffer", () => {
  const { reg, workerId } = readyRegistry();
  assert.throws(() => reg.sendPrompt(workerId, undefined, undefined), /no prompt to send/);
});

// ---------------------------------------------------------------------------
// observe — tool permission prompt
// ---------------------------------------------------------------------------

test("observe: tool permission prompt blocks at tool_permission_required", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-mcp", [], true);

  const blocked = reg.observe(
    worker.workerId,
    'Allow the omx_memory MCP server to run tool "project_memory_read"?\n1. Yes, allow once\n2. Always allow this tool',
  );

  assert.equal(blocked.status, "tool_permission_required");
  assert.equal(blocked.lastError?.kind, "tool_permission_gate");

  const evt = blocked.events.find((e) => e.kind === "tool_permission_required");
  assert.ok(evt !== undefined);
  assert.equal(evt.payload?.type, "tool_permission_prompt");
  assert.equal(evt.payload?.serverName, "omx_memory");
  assert.equal(evt.payload?.toolName, "project_memory_read");
  assert.equal(evt.payload?.allowScope, "session_or_always");
});

// ---------------------------------------------------------------------------
// awaitReady
// ---------------------------------------------------------------------------

test("awaitReady: spawning → not ready, not blocked", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], false);
  const snap = reg.awaitReady(worker.workerId);
  assert.equal(snap.ready, false);
  assert.equal(snap.blocked, false);
});

test("awaitReady: trust_required → blocked", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo", [], false);
  reg.observe(worker.workerId, "Do you trust the files in this folder?\n1. Yes, proceed");
  const snap = reg.awaitReady(worker.workerId);
  assert.equal(snap.blocked, true);
  assert.equal(snap.ready, false);
});

test("awaitReady: ready_for_prompt → ready", () => {
  const { reg, workerId } = readyRegistry();
  const snap = reg.awaitReady(workerId);
  assert.equal(snap.ready, true);
  assert.equal(snap.blocked, false);
});

// ---------------------------------------------------------------------------
// observe — prompt misdelivery + replay
// ---------------------------------------------------------------------------

test("observe: shell misdelivery detected, replay armed when autoRecover=true", () => {
  const { reg, workerId } = readyRegistry();
  reg.sendPrompt(workerId, "Implement worker handshake", undefined);

  const recovered = reg.observe(
    workerId,
    "% Implement worker handshake\nzsh: command not found: Implement",
  );

  assert.equal(recovered.status, "ready_for_prompt");
  assert.equal(recovered.lastError?.kind, "prompt_delivery");
  assert.equal(recovered.replayPrompt, "Implement worker handshake");

  const misdelivery = recovered.events.find((e) => e.kind === "prompt_misdelivery");
  assert.ok(misdelivery !== undefined);
  assert.equal(misdelivery.payload?.type, "prompt_delivery");
  assert.equal(misdelivery.payload?.observedTarget, "shell");
  assert.equal(misdelivery.payload?.recoveryArmed, false);

  const replay = recovered.events.find((e) => e.kind === "prompt_replay_armed");
  assert.ok(replay !== undefined);
  assert.equal(replay.payload?.type, "prompt_delivery");
  assert.equal(replay.payload?.recoveryArmed, true);
});

test("observe: wrong-target misdelivery detected", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-target-a", [], true);
  reg.observe(worker.workerId, "Ready for input\n>");
  reg.sendPrompt(worker.workerId, "Run the worker bootstrap tests", undefined);

  const recovered = reg.observe(
    worker.workerId,
    "/tmp/repo-target-b % Run the worker bootstrap tests\nzsh: command not found: Run",
  );

  assert.equal(recovered.status, "ready_for_prompt");
  assert.equal(recovered.replayPrompt, "Run the worker bootstrap tests");

  const misdelivery = recovered.events.find((e) => e.kind === "prompt_misdelivery");
  assert.equal(misdelivery?.payload?.type, "prompt_delivery");
  assert.equal(misdelivery?.payload?.observedTarget, "wrong_target");
});

test("observe: wrong-task receipt mismatch detected", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-task", [], true);
  reg.observe(worker.workerId, "Ready for input\n>");
  reg.sendPrompt(worker.workerId, "Implement worker handshake", {
    repo: "claw-code",
    taskKind: "repo_code",
    sourceSurface: "omx_team",
    expectedArtifacts: ["patch", "tests"],
    objectivePreview: "Implement worker handshake",
  });

  const recovered = reg.observe(
    worker.workerId,
    "› Explain this KakaoTalk screenshot for a friend\nI can help analyze the screenshot…",
  );

  assert.equal(recovered.status, "ready_for_prompt");
  const mismatch = recovered.events.find((e) => e.kind === "prompt_misdelivery");
  assert.equal(mismatch?.payload?.type, "prompt_delivery");
  assert.equal(mismatch?.payload?.observedTarget, "wrong_task");
});

// ---------------------------------------------------------------------------
// restart / terminate
// ---------------------------------------------------------------------------

test("restart: resets state back to spawning", () => {
  const { reg, workerId } = readyRegistry();
  reg.sendPrompt(workerId, "Run tests", undefined);
  const restarted = reg.restart(workerId);
  assert.equal(restarted.status, "spawning");
  assert.equal(restarted.promptDeliveryAttempts, 0);
  assert.equal(restarted.promptInFlight, false);
  assert.equal(restarted.lastPrompt, undefined);
  assert.equal(restarted.trustGateCleared, false);
});

test("terminate: transitions to finished", () => {
  const { reg, workerId } = readyRegistry();
  const finished = reg.terminate(workerId);
  assert.equal(finished.status, "finished");
  assert.ok(finished.events.some((e) => e.kind === "finished"));
});

// ---------------------------------------------------------------------------
// observeCompletion
// ---------------------------------------------------------------------------

test("observeCompletion: unknown finish with zero tokens → failed (provider)", () => {
  const { reg, workerId } = readyRegistry();
  reg.sendPrompt(workerId, "Run tests", undefined);
  const failed = reg.observeCompletion(workerId, "unknown", 0);
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError?.kind, "provider");
  assert.ok(failed.lastError?.message.includes("provider degraded"));
});

test("observeCompletion: normal stop finish → finished", () => {
  const { reg, workerId } = readyRegistry();
  reg.sendPrompt(workerId, "Run tests", undefined);
  const finished = reg.observeCompletion(workerId, "stop", 150);
  assert.equal(finished.status, "finished");
  assert.equal(finished.lastError, undefined);
});

test("observeCompletion: error finish reason → failed (provider)", () => {
  const { reg, workerId } = readyRegistry();
  reg.sendPrompt(workerId, "Run tests", undefined);
  const failed = reg.observeCompletion(workerId, "error", 10);
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError?.kind, "provider");
});

// ---------------------------------------------------------------------------
// observeStartupTimeout
// ---------------------------------------------------------------------------

test("observeStartupTimeout: transport dead → TransportDead classification", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-timeout", [], true);

  const timedOut = reg.observeStartupTimeout(worker.workerId, "cargo test", false, true);
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.lastError?.kind, "startup_no_evidence");

  const evt = timedOut.events.find((e) => e.kind === "startup_no_evidence");
  assert.ok(evt !== undefined);
  assert.equal(evt.payload?.type, "startup_no_evidence");
  assert.equal(evt.payload?.classification, "transport_dead");
  assert.equal(evt.payload?.evidence.paneCommand, "cargo test");
  assert.equal(evt.payload?.evidence.transportHealthy, false);
});

test("observeStartupTimeout: trust blocked → trust_required classification", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-trust", [], false);
  reg.observe(worker.workerId, "Do you trust the files in this folder?\n1. Yes, proceed");

  const timedOut = reg.observeStartupTimeout(worker.workerId, "claw prompt", true, true);
  const evt = timedOut.events.find((e) => e.kind === "startup_no_evidence");
  assert.equal(evt?.payload?.classification, "trust_required");
  assert.equal(evt?.payload?.evidence.trustPromptDetected, true);
});

test("observeStartupTimeout: tool permission blocked → tool_permission_required classification", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-mcp-timeout", [], true);
  reg.observe(
    worker.workerId,
    'Allow the omx_memory MCP server to run tool "notepad_read"?\n1. Yes, allow once',
  );

  const timedOut = reg.observeStartupTimeout(worker.workerId, "claw prompt", true, true);
  const evt = timedOut.events.find((e) => e.kind === "startup_no_evidence");
  assert.equal(evt?.payload?.classification, "tool_permission_required");
  assert.equal(evt?.payload?.evidence.toolPermissionPromptDetected, true);
  assert.equal(evt?.payload?.evidence.toolPermissionAllowScope, "session_only");
  assert.ok(evt?.payload?.evidence.toolPermissionPromptAgeSeconds !== undefined);
});

test("observeStartupTimeout: mcp unhealthy + transport healthy → worker_crashed", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-crash", [], true);

  const timedOut = reg.observeStartupTimeout(worker.workerId, "claw prompt", true, false);
  const evt = timedOut.events.find((e) => e.kind === "startup_no_evidence");
  assert.equal(evt?.payload?.classification, "worker_crashed");
});

test("observeStartupTimeout: all healthy, no signals → unknown classification", () => {
  const reg = new WorkerRegistry(makeClock());
  const worker = reg.create("/tmp/repo-unknown", [], true);

  const timedOut = reg.observeStartupTimeout(worker.workerId, "claw prompt", true, true);
  const evt = timedOut.events.find((e) => e.kind === "startup_no_evidence");
  assert.equal(evt?.payload?.classification, "unknown");
});
