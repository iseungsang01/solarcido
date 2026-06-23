import assert from "node:assert/strict";
import test from "node:test";

import { dueJobs, validateCronJobs, CronScheduler } from "../dist/runtime/cron/scheduler.js";

// UTC date helper
const d = (year, month1, day, hour, minute) =>
  new Date(Date.UTC(year, month1 - 1, day, hour, minute));

// ---------------------------------------------------------------------------
// dueJobs
// ---------------------------------------------------------------------------

test("dueJobs: returns empty array when no jobs match", () => {
  const jobs = [{ name: "daily", schedule: "0 9 * * *", goal: "run daily report" }];
  // at 08:00 — does not match 09:00
  const result = dueJobs(jobs, d(2026, 1, 1, 8, 0));
  assert.deepEqual(result, []);
});

test("dueJobs: returns matching job for an exact minute/hour", () => {
  const jobs = [
    { name: "morning", schedule: "0 9 * * *", goal: "morning task" },
    { name: "noon",    schedule: "0 12 * * *", goal: "noon task"    },
  ];
  const result = dueJobs(jobs, d(2026, 6, 24, 9, 0));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "morning");
});

test("dueJobs: returns all jobs when multiple schedules match", () => {
  const jobs = [
    { name: "a", schedule: "*/15 * * * *", goal: "every 15 min" },
    { name: "b", schedule: "0,15,30,45 * * * *", goal: "same pattern list" },
  ];
  // both should match at :15
  const result = dueJobs(jobs, d(2026, 1, 1, 0, 15));
  assert.equal(result.length, 2);
});

test("dueJobs: silently skips jobs with invalid schedules", () => {
  const jobs = [
    { name: "bad",  schedule: "not-a-cron", goal: "broken" },
    { name: "good", schedule: "0 9 * * *",  goal: "ok"     },
  ];
  const result = dueJobs(jobs, d(2026, 6, 24, 9, 0));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "good");
});

test("dueJobs: handles empty job list", () => {
  assert.deepEqual(dueJobs([], d(2026, 1, 1, 0, 0)), []);
});

test("dueJobs: */15 fires on :00, :15, :30, :45 but not :01", () => {
  const jobs = [{ name: "quarter", schedule: "*/15 * * * *", goal: "q" }];
  for (const minute of [0, 15, 30, 45]) {
    const result = dueJobs(jobs, d(2026, 1, 1, 0, minute));
    assert.equal(result.length, 1, `expected match at :${minute}`);
  }
  assert.deepEqual(dueJobs(jobs, d(2026, 1, 1, 0, 1)), []);
});

test("dueJobs: day-of-week restriction filters correctly", () => {
  // only Monday (dow=1); 2026-06-22 is a Monday
  const jobs = [{ name: "weekly", schedule: "0 9 * * 1", goal: "monday job" }];
  assert.equal(dueJobs(jobs, d(2026, 6, 22, 9, 0)).length, 1);  // Monday
  assert.equal(dueJobs(jobs, d(2026, 6, 23, 9, 0)).length, 0);  // Tuesday
});

test("dueJobs: month restriction filters correctly", () => {
  const jobs = [{ name: "jan-only", schedule: "0 0 1 1 *", goal: "new year" }];
  assert.equal(dueJobs(jobs, d(2026, 1, 1, 0, 0)).length, 1);
  assert.equal(dueJobs(jobs, d(2026, 2, 1, 0, 0)).length, 0);
});

test("dueJobs: returns a specific fixed-date subset from a mixed list", () => {
  // at 2026-06-24 09:15 UTC (Wednesday)
  const at = d(2026, 6, 24, 9, 15);
  const jobs = [
    { name: "every-15",   schedule: "*/15 9 * * *",  goal: "a" }, // matches
    { name: "on-the-hour",schedule: "0 9 * * *",     goal: "b" }, // does not match (:15)
    { name: "wed-only",   schedule: "15 9 * * 3",    goal: "c" }, // matches (Wednesday=3)
    { name: "daily-noon", schedule: "0 12 * * *",    goal: "d" }, // does not match
  ];
  const result = dueJobs(jobs, at);
  const names = result.map((j) => j.name).sort();
  assert.deepEqual(names, ["every-15", "wed-only"]);
});

// ---------------------------------------------------------------------------
// validateCronJobs
// ---------------------------------------------------------------------------

test("validateCronJobs: all valid jobs land in ok", () => {
  const jobs = [
    { name: "a", schedule: "* * * * *",    goal: "g1" },
    { name: "b", schedule: "0 9 * * *",    goal: "g2" },
    { name: "c", schedule: "*/30 * * * *", goal: "g3" },
  ];
  const { ok, errors } = validateCronJobs(jobs);
  assert.equal(ok.length, 3);
  assert.equal(errors.length, 0);
});

test("validateCronJobs: invalid jobs land in errors with name and message", () => {
  const jobs = [
    { name: "bad1", schedule: "not-valid",      goal: "g" },
    { name: "bad2", schedule: "*/0 * * * *",    goal: "g" },
    { name: "good", schedule: "0 9 * * *",      goal: "g" },
  ];
  const { ok, errors } = validateCronJobs(jobs);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, "good");
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => typeof e.name === "string" && typeof e.error === "string"));
  const errorNames = errors.map((e) => e.name).sort();
  assert.deepEqual(errorNames, ["bad1", "bad2"]);
});

test("validateCronJobs: empty list returns empty ok and errors", () => {
  const { ok, errors } = validateCronJobs([]);
  assert.deepEqual(ok, []);
  assert.deepEqual(errors, []);
});

test("validateCronJobs: error message is non-empty for bad schedule", () => {
  const { errors } = validateCronJobs([{ name: "x", schedule: "60 * * * *", goal: "g" }]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error.length > 0);
});

// ---------------------------------------------------------------------------
// CronScheduler class (thin wrapper)
// ---------------------------------------------------------------------------

test("CronScheduler.dueJobs delegates to the pure function", () => {
  const scheduler = new CronScheduler();
  const jobs = [{ name: "j", schedule: "0 0 * * *", goal: "midnight" }];
  assert.equal(scheduler.dueJobs(jobs, d(2026, 1, 1, 0, 0)).length, 1);
  assert.equal(scheduler.dueJobs(jobs, d(2026, 1, 1, 0, 1)).length, 0);
});

test("CronScheduler.validateCronJobs delegates to the pure function", () => {
  const scheduler = new CronScheduler();
  const jobs = [
    { name: "ok",  schedule: "* * * * *", goal: "g" },
    { name: "bad", schedule: "bad",        goal: "g" },
  ];
  const { ok, errors } = scheduler.validateCronJobs(jobs);
  assert.equal(ok.length, 1);
  assert.equal(errors.length, 1);
});
