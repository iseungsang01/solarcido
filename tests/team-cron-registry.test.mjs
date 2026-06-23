import assert from "node:assert/strict";
import test from "node:test";

import { TeamRegistry, CronRegistry } from "../dist/runtime/team-cron-registry.js";

// ---------------------------------------------------------------------------
// Deterministic clock for tests
// ---------------------------------------------------------------------------

function makeClock() {
  let counter = 0;
  let ts = 2_000_000;
  return {
    nextId: () => ++counter,
    nowSecs: () => ts++,
  };
}

// ===========================================================================
// TeamRegistry
// ===========================================================================

test("TeamRegistry: new registry is empty", () => {
  const reg = new TeamRegistry(makeClock());
  assert.equal(reg.isEmpty, true);
  assert.equal(reg.size, 0);
  assert.deepEqual(reg.list(), []);
});

test("TeamRegistry create: returns team with status=created", () => {
  const reg = new TeamRegistry(makeClock());
  const team = reg.create("Alpha Squad", ["task_001", "task_002"]);
  assert.equal(team.name, "Alpha Squad");
  assert.deepEqual(team.taskIds, ["task_001", "task_002"]);
  assert.equal(team.status, "created");
  assert.ok(team.teamId.startsWith("team_"));
});

test("TeamRegistry get: returns copy of created team", () => {
  const reg = new TeamRegistry(makeClock());
  const team = reg.create("Bravo", []);
  const fetched = reg.get(team.teamId);
  assert.ok(fetched !== undefined);
  assert.equal(fetched.teamId, team.teamId);
});

test("TeamRegistry get: returns undefined for missing teamId", () => {
  const reg = new TeamRegistry(makeClock());
  assert.equal(reg.get("nonexistent"), undefined);
});

test("TeamRegistry list: returns all teams", () => {
  const reg = new TeamRegistry(makeClock());
  reg.create("Team A", []);
  reg.create("Team B", []);
  assert.equal(reg.list().length, 2);
});

test("TeamRegistry delete: soft-deletes team (still retrievable)", () => {
  const reg = new TeamRegistry(makeClock());
  const team = reg.create("Soft Delete Me", []);
  const deleted = reg.delete(team.teamId);
  assert.equal(deleted.status, "deleted");
  const stillThere = reg.get(team.teamId);
  assert.ok(stillThere !== undefined);
  assert.equal(stillThere.status, "deleted");
});

test("TeamRegistry delete: throws on missing teamId", () => {
  const reg = new TeamRegistry(makeClock());
  assert.throws(() => reg.delete("nonexistent"), /team not found/);
});

test("TeamRegistry remove: hard-removes team", () => {
  const reg = new TeamRegistry(makeClock());
  const t1 = reg.create("Team A", []);
  const t2 = reg.create("Team B", []);
  reg.delete(t1.teamId); // soft-delete
  const removed = reg.remove(t2.teamId); // hard-remove t2
  assert.ok(removed !== undefined);
  assert.equal(reg.size, 1); // t1 (soft-deleted) still in map
});

test("TeamRegistry remove: returns undefined for nonexistent teamId", () => {
  const reg = new TeamRegistry(makeClock());
  assert.equal(reg.remove("missing"), undefined);
});

test("TeamRegistry size: increments and decrements correctly", () => {
  const reg = new TeamRegistry(makeClock());
  const alpha = reg.create("Alpha", []);
  const beta = reg.create("Beta", []);
  assert.equal(reg.size, 2);
  reg.remove(alpha.teamId);
  assert.equal(reg.size, 1);
  reg.remove(beta.teamId);
  assert.equal(reg.size, 0);
  assert.equal(reg.isEmpty, true);
});

test("TeamRegistry: taskIds are copied defensively on create", () => {
  const reg = new TeamRegistry(makeClock());
  const ids = ["task_1"];
  const team = reg.create("Defensive", ids);
  ids.push("task_2");
  // stored copy should not reflect external mutation
  assert.equal(team.taskIds.length, 1);
});

// ===========================================================================
// CronRegistry
// ===========================================================================

test("CronRegistry: new registry is empty", () => {
  const reg = new CronRegistry(makeClock());
  assert.equal(reg.isEmpty, true);
  assert.equal(reg.size, 0);
  assert.deepEqual(reg.list(false), []);
  assert.deepEqual(reg.list(true), []);
});

test("CronRegistry create: returns enabled entry with correct fields", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("0 * * * *", "Check status", "hourly check");
  assert.equal(entry.schedule, "0 * * * *");
  assert.equal(entry.prompt, "Check status");
  assert.equal(entry.description, "hourly check");
  assert.equal(entry.enabled, true);
  assert.equal(entry.runCount, 0);
  assert.equal(entry.lastRunAt, undefined);
  assert.ok(entry.cronId.startsWith("cron_"));
});

test("CronRegistry create: without description sets description to undefined", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("*/15 * * * *", "Check health");
  assert.equal(entry.description, undefined);
});

test("CronRegistry get: returns copy of entry", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("* * * * *", "Pulse");
  const fetched = reg.get(entry.cronId);
  assert.ok(fetched !== undefined);
  assert.equal(fetched.cronId, entry.cronId);
});

test("CronRegistry get: returns undefined for missing cronId", () => {
  const reg = new CronRegistry(makeClock());
  assert.equal(reg.get("nonexistent"), undefined);
});

test("CronRegistry list(false): returns all entries including disabled", () => {
  const reg = new CronRegistry(makeClock());
  const c1 = reg.create("* * * * *", "Task 1");
  reg.create("0 * * * *", "Task 2");
  reg.disable(c1.cronId);
  assert.equal(reg.list(false).length, 2);
});

test("CronRegistry list(true): returns only enabled entries", () => {
  const reg = new CronRegistry(makeClock());
  const c1 = reg.create("* * * * *", "Task 1");
  const c2 = reg.create("0 * * * *", "Task 2");
  reg.disable(c1.cronId);
  const enabled = reg.list(true);
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].cronId, c2.cronId);
});

test("CronRegistry list(true): empty when all entries disabled", () => {
  const reg = new CronRegistry(makeClock());
  const c1 = reg.create("* * * * *", "Task 1");
  const c2 = reg.create("0 * * * *", "Task 2");
  reg.disable(c1.cronId);
  reg.disable(c2.cronId);
  assert.deepEqual(reg.list(true), []);
  assert.equal(reg.list(false).length, 2);
});

test("CronRegistry disable: marks entry as disabled", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("0 0 * * *", "Nightly");
  reg.disable(entry.cronId);
  const fetched = reg.get(entry.cronId);
  assert.equal(fetched?.enabled, false);
});

test("CronRegistry disable: throws on missing cronId", () => {
  const reg = new CronRegistry(makeClock());
  assert.throws(() => reg.disable("nonexistent"), /cron not found/);
});

test("CronRegistry recordRun: increments runCount and sets lastRunAt", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("*/5 * * * *", "Recurring");
  reg.recordRun(entry.cronId);
  reg.recordRun(entry.cronId);
  const fetched = reg.get(entry.cronId);
  assert.equal(fetched?.runCount, 2);
  assert.ok(fetched?.lastRunAt !== undefined);
});

test("CronRegistry recordRun: throws on missing cronId", () => {
  const reg = new CronRegistry(makeClock());
  assert.throws(() => reg.recordRun("nonexistent"), /cron not found/);
});

test("CronRegistry delete: hard-removes entry and returns it", () => {
  const reg = new CronRegistry(makeClock());
  const entry = reg.create("* * * * *", "To delete");
  const deleted = reg.delete(entry.cronId);
  assert.equal(deleted.cronId, entry.cronId);
  assert.equal(reg.get(entry.cronId), undefined);
  assert.equal(reg.isEmpty, true);
});

test("CronRegistry delete: throws on missing cronId", () => {
  const reg = new CronRegistry(makeClock());
  assert.throws(() => reg.delete("nonexistent"), /cron not found/);
});

test("CronRegistry size: increments on create, decrements on delete", () => {
  const reg = new CronRegistry(makeClock());
  reg.create("* * * * *", "A");
  const b = reg.create("0 * * * *", "B");
  assert.equal(reg.size, 2);
  reg.delete(b.cronId);
  assert.equal(reg.size, 1);
});
