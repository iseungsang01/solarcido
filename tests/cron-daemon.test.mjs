import assert from "node:assert/strict";
import test from "node:test";

import { parseCronJobs, runCronTick } from "../dist/workflow/cron-daemon.js";

test("parseCronJobs reads an array and a {jobs:[…]} wrapper", () => {
  assert.deepEqual(parseCronJobs(JSON.stringify([{ name: "a", schedule: "* * * * *", goal: "g" }])), [
    { name: "a", schedule: "* * * * *", goal: "g" },
  ]);
  assert.deepEqual(parseCronJobs(JSON.stringify({ jobs: [{ name: "b", schedule: "0 2 * * *", goal: "x" }] })), [
    { name: "b", schedule: "0 2 * * *", goal: "x" },
  ]);
});

test("parseCronJobs rejects invalid JSON, wrong shape, and empty job lists", () => {
  assert.throws(() => parseCronJobs("nope"), /not valid JSON/);
  assert.throws(() => parseCronJobs(JSON.stringify([])), /no valid/);
  assert.throws(() => parseCronJobs(JSON.stringify([{ name: "a" }])), /no valid/);
});

test("runCronTick fires only the due jobs via the injected runner", async () => {
  const jobs = [
    { name: "every", schedule: "* * * * *", goal: "g1" },
    { name: "at-0930", schedule: "30 9 * * *", goal: "g2" },
  ];

  const firedAt0930 = [];
  const due = await runCronTick(jobs, new Date(Date.UTC(2026, 0, 1, 9, 30)), async (job) => {
    firedAt0930.push(job.name);
  });
  assert.deepEqual(firedAt0930.sort(), ["at-0930", "every"]);
  assert.equal(due.length, 2);

  const firedAt1000 = [];
  await runCronTick(jobs, new Date(Date.UTC(2026, 0, 1, 10, 0)), async (job) => {
    firedAt1000.push(job.name);
  });
  assert.deepEqual(firedAt1000, ["every"]);
});
