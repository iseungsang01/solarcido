import assert from "node:assert/strict";
import test from "node:test";

import {
  STALE_BRANCH_THRESHOLD_MS,
  evaluate,
  makeLaneContext,
  makePolicyEngine,
  makePolicyRule,
  makeReconciledLaneContext,
  matchesCondition,
} from "../dist/runtime/policy-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultContext() {
  return makeLaneContext("lane-7", 0, 0, "none", "pending", "full", false);
}

// ---------------------------------------------------------------------------
// Individual condition matching
// ---------------------------------------------------------------------------

test("GreenAt condition matches when greenLevel >= required", () => {
  const ctx = makeLaneContext("lane-1", 3, 0, "none", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "green_at", level: 2 }, ctx), true);
  assert.equal(matchesCondition({ kind: "green_at", level: 3 }, ctx), true);
  assert.equal(matchesCondition({ kind: "green_at", level: 4 }, ctx), false);
});

test("StaleBranch condition fires at threshold", () => {
  const fresh = makeLaneContext("lane-1", 0, STALE_BRANCH_THRESHOLD_MS - 1, "none", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "stale_branch" }, fresh), false);

  const stale = makeLaneContext("lane-1", 0, STALE_BRANCH_THRESHOLD_MS, "none", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "stale_branch" }, stale), true);
});

test("StartupBlocked condition matches only startup blocker", () => {
  const startupCtx = makeLaneContext("lane-1", 0, 0, "startup", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "startup_blocked" }, startupCtx), true);

  const externalCtx = makeLaneContext("lane-1", 0, 0, "external", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "startup_blocked" }, externalCtx), false);
});

test("LaneCompleted condition matches completed flag", () => {
  const done = makeLaneContext("lane-1", 0, 0, "none", "pending", "full", true);
  assert.equal(matchesCondition({ kind: "lane_completed" }, done), true);

  const running = defaultContext();
  assert.equal(matchesCondition({ kind: "lane_completed" }, running), false);
});

test("LaneReconciled condition matches reconciled flag", () => {
  const reconciled = makeReconciledLaneContext("lane-9");
  assert.equal(matchesCondition({ kind: "lane_reconciled" }, reconciled), true);
  assert.equal(matchesCondition({ kind: "lane_reconciled" }, defaultContext()), false);
});

test("ReviewPassed condition matches approved review status", () => {
  const approved = makeLaneContext("lane-1", 0, 0, "none", "approved", "full", false);
  assert.equal(matchesCondition({ kind: "review_passed" }, approved), true);

  const pending = defaultContext();
  assert.equal(matchesCondition({ kind: "review_passed" }, pending), false);
});

test("ScopedDiff condition matches scoped diff scope", () => {
  const scoped = makeLaneContext("lane-1", 0, 0, "none", "pending", "scoped", false);
  assert.equal(matchesCondition({ kind: "scoped_diff" }, scoped), true);

  const full = defaultContext();
  assert.equal(matchesCondition({ kind: "scoped_diff" }, full), false);
});

test("TimedOut condition fires when branchFreshnessMs >= durationMs", () => {
  const ctx = makeLaneContext("lane-1", 0, 10_000, "none", "pending", "full", false);
  assert.equal(matchesCondition({ kind: "timed_out", durationMs: 10_000 }, ctx), true);
  assert.equal(matchesCondition({ kind: "timed_out", durationMs: 10_001 }, ctx), false);
});

// ---------------------------------------------------------------------------
// And / Or combinators
// ---------------------------------------------------------------------------

test("And with empty conditions always matches", () => {
  assert.equal(matchesCondition({ kind: "and", conditions: [] }, defaultContext()), true);
});

test("Or with empty conditions never matches", () => {
  assert.equal(matchesCondition({ kind: "or", conditions: [] }, defaultContext()), false);
});

test("And requires all conditions to match", () => {
  const ctx = makeLaneContext("lane-1", 3, 0, "none", "approved", "scoped", false);
  const cond = {
    kind: "and",
    conditions: [
      { kind: "green_at", level: 2 },
      { kind: "scoped_diff" },
      { kind: "review_passed" },
    ],
  };
  assert.equal(matchesCondition(cond, ctx), true);

  const ctxNoReview = makeLaneContext("lane-1", 3, 0, "none", "pending", "scoped", false);
  assert.equal(matchesCondition(cond, ctxNoReview), false);
});

test("Or matches when any condition matches", () => {
  const ctx = makeLaneContext("lane-1", 0, 0, "startup", "pending", "full", false);
  const cond = {
    kind: "or",
    conditions: [
      { kind: "startup_blocked" },
      { kind: "review_passed" },
    ],
  };
  assert.equal(matchesCondition(cond, ctx), true);
});

// ---------------------------------------------------------------------------
// PolicyEngine: rule evaluation
// ---------------------------------------------------------------------------

test("merge-to-dev rule fires for green + scoped + reviewed lane", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "merge-to-dev",
      { kind: "and", conditions: [{ kind: "green_at", level: 2 }, { kind: "scoped_diff" }, { kind: "review_passed" }] },
      { kind: "merge_to_dev" },
      20,
    ),
  ]);
  const ctx = makeLaneContext("lane-7", 3, 5, "none", "approved", "scoped", false);
  const actions = evaluate(engine, ctx);
  assert.deepEqual(actions, [{ kind: "merge_to_dev" }]);
});

test("stale branch rule fires at threshold", () => {
  const engine = makePolicyEngine([
    makePolicyRule("merge-forward", { kind: "stale_branch" }, { kind: "merge_forward" }, 10),
  ]);
  const ctx = makeLaneContext("lane-7", 1, STALE_BRANCH_THRESHOLD_MS, "none", "pending", "full", false);
  assert.deepEqual(evaluate(engine, ctx), [{ kind: "merge_forward" }]);
});

test("startup-blocked rule chains recover then escalate", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "startup-recovery",
      { kind: "startup_blocked" },
      { kind: "chain", actions: [{ kind: "recover_once" }, { kind: "escalate", reason: "startup remained blocked" }] },
      15,
    ),
  ]);
  const ctx = makeLaneContext("lane-7", 0, 0, "startup", "pending", "full", false);
  const actions = evaluate(engine, ctx);
  assert.deepEqual(actions, [
    { kind: "recover_once" },
    { kind: "escalate", reason: "startup remained blocked" },
  ]);
});

test("completed lane rule closes out and cleans up", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "lane-closeout",
      { kind: "lane_completed" },
      { kind: "chain", actions: [{ kind: "closeout_lane" }, { kind: "cleanup_session" }] },
      30,
    ),
  ]);
  const ctx = makeLaneContext("lane-7", 0, 0, "none", "pending", "full", true);
  assert.deepEqual(evaluate(engine, ctx), [{ kind: "closeout_lane" }, { kind: "cleanup_session" }]);
});

test("rules are returned in priority order", () => {
  const engine = makePolicyEngine([
    makePolicyRule("late-cleanup", { kind: "and", conditions: [] }, { kind: "cleanup_session" }, 30),
    makePolicyRule("first-notify", { kind: "and", conditions: [] }, { kind: "notify", channel: "ops" }, 10),
    makePolicyRule("second-notify", { kind: "and", conditions: [] }, { kind: "notify", channel: "review" }, 10),
    makePolicyRule("merge", { kind: "and", conditions: [] }, { kind: "merge_to_dev" }, 20),
  ]);
  const actions = evaluate(engine, defaultContext());
  assert.deepEqual(actions, [
    { kind: "notify", channel: "ops" },
    { kind: "notify", channel: "review" },
    { kind: "merge_to_dev" },
    { kind: "cleanup_session" },
  ]);
});

test("nested chain actions are flattened in order", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "empty-and",
      { kind: "and", conditions: [] },
      { kind: "notify", channel: "orchestrator" },
      5,
    ),
    makePolicyRule(
      "empty-or",
      { kind: "or", conditions: [] },
      { kind: "block", reason: "should not fire" },
      10,
    ),
    makePolicyRule(
      "nested",
      {
        kind: "or",
        conditions: [
          { kind: "startup_blocked" },
          { kind: "and", conditions: [{ kind: "green_at", level: 2 }, { kind: "timed_out", durationMs: 5_000 }] },
        ],
      },
      {
        kind: "chain",
        actions: [
          { kind: "notify", channel: "alerts" },
          { kind: "chain", actions: [{ kind: "merge_forward" }, { kind: "cleanup_session" }] },
        ],
      },
      15,
    ),
  ]);
  const ctx = makeLaneContext("lane-7", 2, 10_000, "external", "pending", "full", false);
  const actions = evaluate(engine, ctx);
  assert.deepEqual(actions, [
    { kind: "notify", channel: "orchestrator" },
    { kind: "notify", channel: "alerts" },
    { kind: "merge_forward" },
    { kind: "cleanup_session" },
  ]);
});

test("reconciled lane triggers reconcile rule", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "reconcile-closeout",
      { kind: "lane_reconciled" },
      {
        kind: "chain",
        actions: [
          { kind: "reconcile", reason: "already_merged" },
          { kind: "closeout_lane" },
          { kind: "cleanup_session" },
        ],
      },
      5,
    ),
    makePolicyRule(
      "generic-closeout",
      { kind: "and", conditions: [{ kind: "lane_completed" }, { kind: "and", conditions: [] }] },
      { kind: "closeout_lane" },
      30,
    ),
  ]);
  const ctx = makeReconciledLaneContext("lane-9411");
  const actions = evaluate(engine, ctx);
  assert.deepEqual(actions, [
    { kind: "reconcile", reason: "already_merged" },
    { kind: "closeout_lane" },
    { kind: "cleanup_session" },
    { kind: "closeout_lane" },
  ]);
});

test("makeReconciledLaneContext has correct defaults", () => {
  const ctx = makeReconciledLaneContext("test-lane");
  assert.equal(ctx.laneId, "test-lane");
  assert.equal(ctx.completed, true);
  assert.equal(ctx.reconciled, true);
  assert.equal(ctx.blocker, "none");
  assert.equal(ctx.greenLevel, 0);
});

test("non-reconciled completed lane does not trigger reconcile rule", () => {
  const engine = makePolicyEngine([
    makePolicyRule(
      "reconcile-closeout",
      { kind: "lane_reconciled" },
      { kind: "reconcile", reason: "empty_diff" },
      5,
    ),
  ]);
  const ctx = makeLaneContext("lane-7", 0, 0, "none", "pending", "full", true);
  assert.deepEqual(evaluate(engine, ctx), []);
});

test("no rules produce no actions", () => {
  const engine = makePolicyEngine([]);
  assert.deepEqual(evaluate(engine, defaultContext()), []);
});
