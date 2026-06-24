// Lane completion detector — automatically marks lanes as completed when a
// session finishes successfully with green tests and pushed code.
//
// This bridges the gap where `LaneContext.completed` is a passive flag that
// nothing automatically sets. Completion is detected from:
// - Agent output shows a finished status
// - No errors/blockers present
// - Tests passed (green status)
// - Code pushed (has output file)
//
// Pure module — no I/O, no Date.now(), no Math.random(). Ported from the Rust
// reference `crates/tools/src/lane_completion.rs`.

import {
  evaluate,
  makePolicyEngine,
  makePolicyRule,
  type LaneContext,
  type PolicyAction,
} from "./policy-engine.js";

// ---------------------------------------------------------------------------
// AgentOutput — the subset of fields the completion detector reads.
// ---------------------------------------------------------------------------

/**
 * Output record produced by an agent lane. Only the fields consulted by the
 * completion detector are modeled here; the Rust `AgentOutput` carries more
 * bookkeeping (name, manifest file, timestamps, lane events, …) that the
 * detection logic never inspects.
 */
export interface AgentOutput {
  /** Stable identifier for the lane this output belongs to. */
  agentId: string;
  /** Lifecycle status, e.g. "finished"/"completed"/"running" (case-insensitive). */
  status: string;
  /** Present when the lane is currently blocked. */
  currentBlocker?: string;
  /** Present when the lane errored. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a lane should be automatically marked as completed.
 *
 * Returns a `LaneContext` with `completed = true` when every condition is met:
 * - no error,
 * - status is "completed" or "finished" (ASCII case-insensitive),
 * - no current blocker,
 * - tests are green,
 * - code has been pushed.
 *
 * Returns `undefined` if the lane should remain active.
 */
export function detectLaneCompletion(
  output: AgentOutput,
  testGreen: boolean,
  hasPushed: boolean,
): LaneContext | undefined {
  // Must be finished without errors.
  if (output.error !== undefined) {
    return undefined;
  }

  // Must have a finished status.
  const status = output.status.toLowerCase();
  if (status !== "completed" && status !== "finished") {
    return undefined;
  }

  // Must have no current blocker.
  if (output.currentBlocker !== undefined) {
    return undefined;
  }

  // Must have green tests.
  if (!testGreen) {
    return undefined;
  }

  // Must have pushed code.
  if (!hasPushed) {
    return undefined;
  }

  // All conditions met — create a completed context.
  return {
    laneId: output.agentId,
    greenLevel: 3, // Workspace green
    branchFreshnessMs: 0,
    blocker: "none",
    reviewStatus: "approved",
    diffScope: "scoped",
    completed: true,
    reconciled: false,
  };
}

// ---------------------------------------------------------------------------
// Policy evaluation for a completed lane
// ---------------------------------------------------------------------------

/** Evaluate policy actions for a completed lane. */
export function evaluateCompletedLane(context: LaneContext): PolicyAction[] {
  const engine = makePolicyEngine([
    makePolicyRule(
      "closeout-completed-lane",
      { kind: "and", conditions: [{ kind: "lane_completed" }, { kind: "green_at", level: 3 }] },
      { kind: "closeout_lane" },
      10,
    ),
    makePolicyRule(
      "cleanup-completed-session",
      { kind: "lane_completed" },
      { kind: "cleanup_session" },
      5,
    ),
  ]);

  return evaluate(engine, context);
}
