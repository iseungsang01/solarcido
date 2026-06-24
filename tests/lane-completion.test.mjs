import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLaneCompletion,
  evaluateCompletedLane,
} from "../dist/runtime/lane-completion.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mirrors the Rust `test_output()`: a finished lane with no blocker/error.
// Status is intentionally mixed-case ("Finished") to exercise the
// case-insensitive status match.
function testOutput() {
  return {
    agentId: "test-lane-1",
    status: "Finished",
  };
}

function containsAction(actions, kind) {
  return actions.some((a) => a.kind === kind);
}

// ---------------------------------------------------------------------------
// detectLaneCompletion
// ---------------------------------------------------------------------------

test("detects completion when all conditions met", () => {
  const output = testOutput();
  const result = detectLaneCompletion(output, true, true);

  assert.notEqual(result, undefined);
  assert.equal(result.completed, true);
  assert.equal(result.greenLevel, 3);
  assert.equal(result.blocker, "none");
  assert.equal(result.laneId, "test-lane-1");
  assert.equal(result.reviewStatus, "approved");
  assert.equal(result.diffScope, "scoped");
  assert.equal(result.reconciled, false);
});

test("no completion when error present", () => {
  const output = { ...testOutput(), error: "Build failed" };
  assert.equal(detectLaneCompletion(output, true, true), undefined);
});

test("no completion when not finished", () => {
  const output = { ...testOutput(), status: "Running" };
  assert.equal(detectLaneCompletion(output, true, true), undefined);
});

test("no completion when tests not green", () => {
  const output = testOutput();
  assert.equal(detectLaneCompletion(output, false, true), undefined);
});

test("no completion when not pushed", () => {
  const output = testOutput();
  assert.equal(detectLaneCompletion(output, true, false), undefined);
});

// Extra boundary cases beyond the Rust suite, exercising the remaining rules.

test("no completion when a blocker is present", () => {
  const output = { ...testOutput(), currentBlocker: "waiting on review" };
  assert.equal(detectLaneCompletion(output, true, true), undefined);
});

test('accepts "completed" status (case-insensitive)', () => {
  const output = { ...testOutput(), status: "COMPLETED" };
  const result = detectLaneCompletion(output, true, true);
  assert.notEqual(result, undefined);
  assert.equal(result.completed, true);
});

// ---------------------------------------------------------------------------
// evaluateCompletedLane
// ---------------------------------------------------------------------------

test("evaluate triggers closeout and cleanup for completed lane", () => {
  const context = {
    laneId: "completed-lane",
    greenLevel: 3,
    branchFreshnessMs: 0,
    blocker: "none",
    reviewStatus: "approved",
    diffScope: "scoped",
    completed: true,
    reconciled: false,
  };

  const actions = evaluateCompletedLane(context);

  assert.ok(containsAction(actions, "closeout_lane"));
  assert.ok(containsAction(actions, "cleanup_session"));
});

test("evaluate produces no closeout for an incomplete lane", () => {
  const context = {
    laneId: "active-lane",
    greenLevel: 0,
    branchFreshnessMs: 0,
    blocker: "none",
    reviewStatus: "pending",
    diffScope: "full",
    completed: false,
    reconciled: false,
  };

  assert.deepEqual(evaluateCompletedLane(context), []);
});

test("evaluate skips closeout below workspace green but still cleans up", () => {
  // completed but greenLevel < 3 — the closeout rule's green_at gate fails,
  // yet the cleanup rule (lane_completed only) still fires.
  const context = {
    laneId: "low-green-lane",
    greenLevel: 2,
    branchFreshnessMs: 0,
    blocker: "none",
    reviewStatus: "approved",
    diffScope: "scoped",
    completed: true,
    reconciled: false,
  };

  const actions = evaluateCompletedLane(context);
  assert.equal(containsAction(actions, "closeout_lane"), false);
  assert.ok(containsAction(actions, "cleanup_session"));
});
