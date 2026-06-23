// Policy engine: pure evaluation of lane state against a rule set.
// No I/O, no Date.now(), no Math.random().

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Numeric green level — higher means more test coverage confirmed. */
export type GreenLevel = number;

/** How stale a branch is, expressed in milliseconds. */
export type FreshnessDurationMs = number;

export type LaneBlocker = "none" | "startup" | "external";

export type ReviewStatus = "pending" | "approved" | "rejected";

export type DiffScope = "full" | "scoped";

export interface LaneContext {
  laneId: string;
  greenLevel: GreenLevel;
  /** Milliseconds since the branch was last rebased against main. */
  branchFreshnessMs: FreshnessDurationMs;
  blocker: LaneBlocker;
  reviewStatus: ReviewStatus;
  diffScope: DiffScope;
  completed: boolean;
  reconciled: boolean;
}

export type ReconcileReason =
  | "already_merged"
  | "superseded"
  | "empty_diff"
  | "manual_close";

export type PolicyAction =
  | { kind: "merge_to_dev" }
  | { kind: "merge_forward" }
  | { kind: "recover_once" }
  | { kind: "escalate"; reason: string }
  | { kind: "closeout_lane" }
  | { kind: "cleanup_session" }
  | { kind: "reconcile"; reason: ReconcileReason }
  | { kind: "notify"; channel: string }
  | { kind: "block"; reason: string }
  | { kind: "chain"; actions: PolicyAction[] };

export type PolicyCondition =
  | { kind: "and"; conditions: PolicyCondition[] }
  | { kind: "or"; conditions: PolicyCondition[] }
  | { kind: "green_at"; level: GreenLevel }
  | { kind: "stale_branch" }
  | { kind: "startup_blocked" }
  | { kind: "lane_completed" }
  | { kind: "lane_reconciled" }
  | { kind: "review_passed" }
  | { kind: "scoped_diff" }
  | { kind: "timed_out"; durationMs: FreshnessDurationMs };

export interface PolicyRule {
  name: string;
  condition: PolicyCondition;
  action: PolicyAction;
  /** Lower priority number = evaluated first. */
  priority: number;
}

export interface PolicyEngine {
  readonly rules: PolicyRule[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One hour in ms — branch is stale when freshness reaches or exceeds this. */
export const STALE_BRANCH_THRESHOLD_MS: FreshnessDurationMs = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function makePolicyRule(
  name: string,
  condition: PolicyCondition,
  action: PolicyAction,
  priority: number,
): PolicyRule {
  return { name, condition, action, priority };
}

/** Build a PolicyEngine with rules sorted ascending by priority. */
export function makePolicyEngine(rules: PolicyRule[]): PolicyEngine {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  return { rules: sorted };
}

/** Build a fresh LaneContext. reconciled defaults to false. */
export function makeLaneContext(
  laneId: string,
  greenLevel: GreenLevel,
  branchFreshnessMs: FreshnessDurationMs,
  blocker: LaneBlocker,
  reviewStatus: ReviewStatus,
  diffScope: DiffScope,
  completed: boolean,
): LaneContext {
  return { laneId, greenLevel, branchFreshnessMs, blocker, reviewStatus, diffScope, completed, reconciled: false };
}

/** Build a lane context that is already reconciled. */
export function makeReconciledLaneContext(laneId: string): LaneContext {
  return {
    laneId,
    greenLevel: 0,
    branchFreshnessMs: 0,
    blocker: "none",
    reviewStatus: "pending",
    diffScope: "full",
    completed: true,
    reconciled: true,
  };
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

export function matchesCondition(condition: PolicyCondition, context: LaneContext): boolean {
  switch (condition.kind) {
    case "and":
      return condition.conditions.every((c) => matchesCondition(c, context));
    case "or":
      return condition.conditions.some((c) => matchesCondition(c, context));
    case "green_at":
      return context.greenLevel >= condition.level;
    case "stale_branch":
      return context.branchFreshnessMs >= STALE_BRANCH_THRESHOLD_MS;
    case "startup_blocked":
      return context.blocker === "startup";
    case "lane_completed":
      return context.completed;
    case "lane_reconciled":
      return context.reconciled;
    case "review_passed":
      return context.reviewStatus === "approved";
    case "scoped_diff":
      return context.diffScope === "scoped";
    case "timed_out":
      return context.branchFreshnessMs >= condition.durationMs;
  }
}

// ---------------------------------------------------------------------------
// Action flattening
// ---------------------------------------------------------------------------

function flattenActions(action: PolicyAction, out: PolicyAction[]): void {
  if (action.kind === "chain") {
    for (const sub of action.actions) {
      flattenActions(sub, out);
    }
  } else {
    out.push(action);
  }
}

// ---------------------------------------------------------------------------
// Engine evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate all rules in priority order against the given context.
 * Chain actions are expanded inline. Returns all matching actions.
 */
export function evaluate(engine: PolicyEngine, context: LaneContext): PolicyAction[] {
  const actions: PolicyAction[] = [];
  for (const rule of engine.rules) {
    if (matchesCondition(rule.condition, context)) {
      flattenActions(rule.action, actions);
    }
  }
  return actions;
}
