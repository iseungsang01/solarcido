import assert from "node:assert/strict";
import test from "node:test";

import { TaskRegistry, isTerminalStatus } from "../dist/runtime/task-registry.js";
import { TaskScope, TaskPacketValidationError } from "../dist/runtime/task-packet.js";

// ---------------------------------------------------------------------------
// Deterministic clock for tests
// ---------------------------------------------------------------------------

function makeClock() {
  let counter = 0;
  let ts = 1_000_000;
  return {
    nextId: () => ++counter,
    nowSecs: () => ts++,
  };
}

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

test("isTerminalStatus: completed/failed/stopped are terminal", () => {
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("failed"), true);
  assert.equal(isTerminalStatus("stopped"), true);
});

test("isTerminalStatus: created/running are not terminal", () => {
  assert.equal(isTerminalStatus("created"), false);
  assert.equal(isTerminalStatus("running"), false);
});

// ---------------------------------------------------------------------------
// create / get
// ---------------------------------------------------------------------------

test("create: returns task with status=created and correct fields", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Do something", "A test task");
  assert.equal(task.status, "created");
  assert.equal(task.prompt, "Do something");
  assert.equal(task.description, "A test task");
  assert.equal(task.taskPacket, undefined);
  assert.equal(task.output, "");
  assert.equal(task.teamId, undefined);
  assert.deepEqual(task.messages, []);
  assert.ok(task.taskId.startsWith("task_"));
});

test("create: without description sets description to undefined", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Do the thing");
  assert.equal(task.description, undefined);
});

test("get: returns copy of created task", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Find me");
  const fetched = reg.get(task.taskId);
  assert.ok(fetched !== undefined);
  assert.equal(fetched.taskId, task.taskId);
});

test("get: returns undefined for missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.equal(reg.get("nonexistent"), undefined);
});

// ---------------------------------------------------------------------------
// createFromPacket
// ---------------------------------------------------------------------------

test("createFromPacket: sets prompt to objective and description to scopePath", () => {
  const reg = new TaskRegistry(makeClock());
  const packet = {
    objective: "Ship task packet support",
    scope: TaskScope.Module,
    scopePath: "runtime/task system",
    repo: "solarcido",
    branchPolicy: "origin/main only",
    acceptanceTests: ["npm test"],
    commitPolicy: "single commit",
    reportingContract: "print commit sha",
    escalationPolicy: "manual escalation",
  };
  const task = reg.createFromPacket(packet);
  assert.equal(task.prompt, packet.objective);
  assert.equal(task.description, "runtime/task system");
  assert.deepEqual(task.taskPacket, packet);
});

test("createFromPacket: uses scope kind as description when scopePath absent (workspace)", () => {
  const reg = new TaskRegistry(makeClock());
  const packet = {
    objective: "Build everything",
    scope: TaskScope.Workspace,
    repo: "solarcido",
    branchPolicy: "main",
    acceptanceTests: [],
    commitPolicy: "single commit",
    reportingContract: "done",
    escalationPolicy: "never",
  };
  const task = reg.createFromPacket(packet);
  assert.equal(task.description, "workspace");
});

test("createFromPacket: throws TaskPacketValidationError on invalid packet", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(
    () => reg.createFromPacket({ objective: "", scope: TaskScope.Workspace, repo: "", branchPolicy: "", acceptanceTests: [], commitPolicy: "", reportingContract: "", escalationPolicy: "" }),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list(undefined): returns all tasks", () => {
  const reg = new TaskRegistry(makeClock());
  reg.create("Task A");
  reg.create("Task B");
  assert.equal(reg.list().length, 2);
});

test("list(status): filters by status", () => {
  const reg = new TaskRegistry(makeClock());
  reg.create("Task A");
  const taskB = reg.create("Task B");
  reg.setStatus(taskB.taskId, "running");

  const running = reg.list("running");
  assert.equal(running.length, 1);
  assert.equal(running[0].taskId, taskB.taskId);

  const created = reg.list("created");
  assert.equal(created.length, 1);
});

// ---------------------------------------------------------------------------
// setStatus / stop
// ---------------------------------------------------------------------------

test("setStatus: transitions task status", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Transition me");
  reg.setStatus(task.taskId, "running");
  const fetched = reg.get(task.taskId);
  assert.equal(fetched?.status, "running");
});

test("setStatus: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.setStatus("nonexistent", "running"), /task not found/);
});

test("stop: transitions running task to stopped", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Stoppable");
  reg.setStatus(task.taskId, "running");
  const stopped = reg.stop(task.taskId);
  assert.equal(stopped.status, "stopped");
});

test("stop: succeeds from created state", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Just created");
  const stopped = reg.stop(task.taskId);
  assert.equal(stopped.status, "stopped");
});

test("stop: throws when already stopped", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Already stopped");
  reg.stop(task.taskId);
  assert.throws(() => reg.stop(task.taskId), /already in terminal state/);
});

test("stop: throws when completed", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Done");
  reg.setStatus(task.taskId, "completed");
  assert.throws(
    () => reg.stop(task.taskId),
    (err) => {
      assert.ok(err.message.includes("already in terminal state"));
      assert.ok(err.message.includes("completed"));
      return true;
    },
  );
});

test("stop: throws when failed", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Failed");
  reg.setStatus(task.taskId, "failed");
  assert.throws(
    () => reg.stop(task.taskId),
    (err) => {
      assert.ok(err.message.includes("already in terminal state"));
      assert.ok(err.message.includes("failed"));
      return true;
    },
  );
});

test("stop: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.stop("nonexistent"), /task not found/);
});

// ---------------------------------------------------------------------------
// update (append message)
// ---------------------------------------------------------------------------

test("update: appends user message to messages", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Messageable");
  const updated = reg.update(task.taskId, "Here's more context");
  assert.equal(updated.messages.length, 1);
  assert.equal(updated.messages[0].content, "Here's more context");
  assert.equal(updated.messages[0].role, "user");
});

test("update: appending multiple messages accumulates correctly", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Multi-message");
  reg.update(task.taskId, "first");
  reg.update(task.taskId, "second");
  const fetched = reg.get(task.taskId);
  assert.equal(fetched?.messages.length, 2);
  assert.equal(fetched?.messages[1].content, "second");
});

test("update: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.update("nonexistent", "msg"), /task not found/);
});

// ---------------------------------------------------------------------------
// appendOutput / output
// ---------------------------------------------------------------------------

test("appendOutput + output: accumulates output fragments", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Output task");
  reg.appendOutput(task.taskId, "line 1\n");
  reg.appendOutput(task.taskId, "line 2\n");
  assert.equal(reg.output(task.taskId), "line 1\nline 2\n");
});

test("appendOutput: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.appendOutput("nonexistent", "data"), /task not found/);
});

test("output: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.output("nonexistent"), /task not found/);
});

// ---------------------------------------------------------------------------
// assignTeam
// ---------------------------------------------------------------------------

test("assignTeam: sets teamId on task", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Team task");
  reg.assignTeam(task.taskId, "team_abc");
  const fetched = reg.get(task.taskId);
  assert.equal(fetched?.teamId, "team_abc");
});

test("assignTeam: throws on missing taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.throws(() => reg.assignTeam("missing", "team_123"), /task not found: missing/);
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test("remove: hard-removes task and returns it", () => {
  const reg = new TaskRegistry(makeClock());
  const task = reg.create("Remove me");
  const removed = reg.remove(task.taskId);
  assert.ok(removed !== undefined);
  assert.equal(reg.get(task.taskId), undefined);
  assert.equal(reg.isEmpty, true);
});

test("remove: returns undefined for nonexistent taskId", () => {
  const reg = new TaskRegistry(makeClock());
  assert.equal(reg.remove("missing"), undefined);
});

// ---------------------------------------------------------------------------
// size / isEmpty
// ---------------------------------------------------------------------------

test("new registry is empty", () => {
  const reg = new TaskRegistry(makeClock());
  assert.equal(reg.isEmpty, true);
  assert.equal(reg.size, 0);
  assert.deepEqual(reg.list(), []);
});

test("size increments on create, decrements on remove", () => {
  const reg = new TaskRegistry(makeClock());
  const a = reg.create("A");
  const b = reg.create("B");
  assert.equal(reg.size, 2);
  reg.remove(a.taskId);
  assert.equal(reg.size, 1);
  reg.remove(b.taskId);
  assert.equal(reg.size, 0);
  assert.equal(reg.isEmpty, true);
});
