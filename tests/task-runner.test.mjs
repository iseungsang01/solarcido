import assert from "node:assert/strict";
import test from "node:test";

import { TaskRegistry } from "../dist/runtime/task-registry.js";
import { TaskRunner } from "../dist/runtime/task-runner.js";

function fixedClock() {
  let n = 0;
  return { nextId: () => (n += 1), nowSecs: () => 1000 };
}

test("runTask completes a task and records its output", async () => {
  const registry = new TaskRegistry(fixedClock());
  const created = registry.create("do thing");
  const runner = new TaskRunner(registry, async (task) => ({ ok: true, output: `done: ${task.prompt}` }));
  const result = await runner.runTask(created.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "done: do thing");
});

test("runTask marks failed when the executor reports failure", async () => {
  const registry = new TaskRegistry(fixedClock());
  const created = registry.create("x");
  const runner = new TaskRunner(registry, async () => ({ ok: false, output: "nope" }));
  const result = await runner.runTask(created.taskId);
  assert.equal(result.status, "failed");
  assert.equal(result.output, "nope");
});

test("runTask captures the error and fails when the executor throws", async () => {
  const registry = new TaskRegistry(fixedClock());
  const created = registry.create("boom");
  const runner = new TaskRunner(registry, async () => {
    throw new Error("kaboom");
  });
  const result = await runner.runTask(created.taskId);
  assert.equal(result.status, "failed");
  assert.match(result.output, /ERROR: kaboom/);
});

test("runPending runs every created task", async () => {
  const registry = new TaskRegistry(fixedClock());
  registry.create("a");
  registry.create("b");
  const seen = [];
  const runner = new TaskRunner(registry, async (task) => {
    seen.push(task.prompt);
    return { ok: true, output: "ok" };
  });
  const results = await runner.runPending();
  assert.equal(results.length, 2);
  assert.deepEqual(seen.sort(), ["a", "b"]);
  assert.ok(results.every((task) => task.status === "completed"));
  assert.equal(registry.list("created").length, 0);
});

test("runBatch runs a specific set of task ids", async () => {
  const registry = new TaskRegistry(fixedClock());
  const a = registry.create("a");
  const b = registry.create("b");
  const runner = new TaskRunner(registry, async () => ({ ok: true, output: "ok" }));
  const results = await runner.runBatch([a.taskId, b.taskId], { concurrency: 2 });
  assert.equal(results.length, 2);
  assert.ok(results.every((task) => task.status === "completed"));
});
