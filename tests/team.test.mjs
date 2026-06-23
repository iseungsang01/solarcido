import assert from "node:assert/strict";
import test from "node:test";

import { parseTasksFile, runTeam, formatTeamReport } from "../dist/workflow/team.js";

test("parseTasksFile reads an array of strings", () => {
  assert.deepEqual(parseTasksFile(JSON.stringify(["a", "b"])), [{ prompt: "a" }, { prompt: "b" }]);
});

test("parseTasksFile reads {tasks:[…]} with string and object items", () => {
  const specs = parseTasksFile(JSON.stringify({ tasks: [{ prompt: "do x", description: "d" }, "y"] }));
  assert.deepEqual(specs, [{ prompt: "do x", description: "d" }, { prompt: "y" }]);
});

test("parseTasksFile rejects invalid JSON, wrong shape, and empty task lists", () => {
  assert.throws(() => parseTasksFile("nope"), /not valid JSON/);
  assert.throws(() => parseTasksFile(JSON.stringify({})), /must be a JSON array/);
  assert.throws(() => parseTasksFile(JSON.stringify([])), /no tasks/);
});

test("runTeam runs every task via an injected executor and reports status", async () => {
  const tasks = [{ prompt: "a" }, { prompt: "fail this" }];
  const executor = async (task) =>
    task.prompt.includes("fail") ? { ok: false, output: "nope" } : { ok: true, output: "ok" };
  const report = await runTeam({ tasks, concurrency: 2 }, executor);
  assert.equal(report.results.length, 2);
  assert.equal(report.completed, 1);
  assert.equal(report.failed, 1);
  const byPrompt = Object.fromEntries(report.results.map((r) => [r.prompt, r.status]));
  assert.equal(byPrompt["a"], "completed");
  assert.equal(byPrompt["fail this"], "failed");
});

test("formatTeamReport summarizes results", () => {
  const text = formatTeamReport({
    results: [{ prompt: "a", status: "completed", output: "ok" }],
    completed: 1,
    failed: 0,
  });
  assert.match(text, /1 completed, 0 failed/);
  assert.match(text, /\[completed\] a/);
});
