// Recovery recipes for common provider-neutral failure scenarios.
//
// Encodes known automatic recoveries for each failure scenario and enforces
// one automatic recovery attempt before escalation. Each attempt is emitted
// as a structured recovery event.
//
// Pure module — no I/O, no Date.now(), no Math.random().

// ---------------------------------------------------------------------------
// FailureScenario
// ---------------------------------------------------------------------------

/**
 * Provider-neutral failure scenarios that have known recovery recipes.
 * Anthropic/OAuth-specific scenarios are intentionally excluded.
 */
export type FailureScenario =
  | "trust_prompt_unresolved"
  | "prompt_misdelivery"
  | "stale_branch"
  | "compile_red_cross_crate"
  | "mcp_handshake_failure"
  | "partial_plugin_startup"
  | "provider_failure";

export const ALL_FAILURE_SCENARIOS: readonly FailureScenario[] = [
  "trust_prompt_unresolved",
  "prompt_misdelivery",
  "stale_branch",
  "compile_red_cross_crate",
  "mcp_handshake_failure",
  "partial_plugin_startup",
  "provider_failure",
];

// ---------------------------------------------------------------------------
// RecoveryStep
// ---------------------------------------------------------------------------

export type RecoveryStep =
  | { kind: "accept_trust_prompt" }
  | { kind: "redirect_prompt_to_agent" }
  | { kind: "rebase_branch" }
  | { kind: "clean_build" }
  | { kind: "retry_mcp_handshake"; timeoutMs: number }
  | { kind: "restart_plugin"; name: string }
  | { kind: "restart_worker" }
  | { kind: "escalate_to_human"; reason: string };

// ---------------------------------------------------------------------------
// EscalationPolicy
// ---------------------------------------------------------------------------

export type EscalationPolicy = "alert_human" | "log_and_continue" | "abort";

// ---------------------------------------------------------------------------
// RecoveryRecipe
// ---------------------------------------------------------------------------

export interface RecoveryRecipe {
  scenario: FailureScenario;
  steps: RecoveryStep[];
  maxAttempts: number;
  escalationPolicy: EscalationPolicy;
}

// ---------------------------------------------------------------------------
// RecoveryResult
// ---------------------------------------------------------------------------

export type RecoveryResult =
  | { kind: "recovered"; stepsTaken: number }
  | { kind: "partial_recovery"; recovered: RecoveryStep[]; remaining: RecoveryStep[] }
  | { kind: "escalation_required"; reason: string };

// ---------------------------------------------------------------------------
// RecoveryEvent
// ---------------------------------------------------------------------------

export type RecoveryEvent =
  | { kind: "recovery_attempted"; scenario: FailureScenario; recipe: RecoveryRecipe; result: RecoveryResult }
  | { kind: "recovery_succeeded" }
  | { kind: "recovery_failed" }
  | { kind: "escalated" };

// ---------------------------------------------------------------------------
// RecoveryContext
// ---------------------------------------------------------------------------

/**
 * Minimal mutable context for tracking recovery state and emitting events.
 * `failAtStep` is a test-only knob: when set, step execution fails at that
 * zero-based index. `undefined` means all steps succeed.
 */
export interface RecoveryContext {
  attempts: Map<FailureScenario, number>;
  events: RecoveryEvent[];
  /** Index at which simulated step execution fails. undefined = all succeed. */
  failAtStep?: number;
}

export function makeRecoveryContext(failAtStep?: number): RecoveryContext {
  return { attempts: new Map(), events: [], failAtStep };
}

export function attemptCount(ctx: RecoveryContext, scenario: FailureScenario): number {
  return ctx.attempts.get(scenario) ?? 0;
}

// ---------------------------------------------------------------------------
// Recipe lookup
// ---------------------------------------------------------------------------

/** Returns the canonical recovery recipe for the given failure scenario. */
export function recipeFor(scenario: FailureScenario): RecoveryRecipe {
  switch (scenario) {
    case "trust_prompt_unresolved":
      return {
        scenario,
        steps: [{ kind: "accept_trust_prompt" }],
        maxAttempts: 1,
        escalationPolicy: "alert_human",
      };
    case "prompt_misdelivery":
      return {
        scenario,
        steps: [{ kind: "redirect_prompt_to_agent" }],
        maxAttempts: 1,
        escalationPolicy: "alert_human",
      };
    case "stale_branch":
      return {
        scenario,
        steps: [{ kind: "rebase_branch" }, { kind: "clean_build" }],
        maxAttempts: 1,
        escalationPolicy: "alert_human",
      };
    case "compile_red_cross_crate":
      return {
        scenario,
        steps: [{ kind: "clean_build" }],
        maxAttempts: 1,
        escalationPolicy: "alert_human",
      };
    case "mcp_handshake_failure":
      return {
        scenario,
        steps: [{ kind: "retry_mcp_handshake", timeoutMs: 5000 }],
        maxAttempts: 1,
        escalationPolicy: "abort",
      };
    case "partial_plugin_startup":
      return {
        scenario,
        steps: [
          { kind: "restart_plugin", name: "stalled" },
          { kind: "retry_mcp_handshake", timeoutMs: 3000 },
        ],
        maxAttempts: 1,
        escalationPolicy: "log_and_continue",
      };
    case "provider_failure":
      return {
        scenario,
        steps: [{ kind: "restart_worker" }],
        maxAttempts: 1,
        escalationPolicy: "alert_human",
      };
  }
}

// ---------------------------------------------------------------------------
// Core recovery logic
// ---------------------------------------------------------------------------

/**
 * Attempt automatic recovery for the given failure scenario.
 *
 * Enforces one automatic attempt before escalation. Simulates step execution
 * using `ctx.failAtStep` for deterministic testing. Appends structured
 * RecoveryEvents to `ctx.events`.
 */
export function attemptRecovery(
  scenario: FailureScenario,
  ctx: RecoveryContext,
): RecoveryResult {
  const recipe = recipeFor(scenario);
  const current = ctx.attempts.get(scenario) ?? 0;

  // Enforce max-attempts before escalation.
  if (current >= recipe.maxAttempts) {
    const result: RecoveryResult = {
      kind: "escalation_required",
      reason: `max recovery attempts (${recipe.maxAttempts}) exceeded for ${scenario}`,
    };
    ctx.events.push({ kind: "recovery_attempted", scenario, recipe, result });
    ctx.events.push({ kind: "escalated" });
    return result;
  }

  ctx.attempts.set(scenario, current + 1);

  // Execute steps, honoring the optional failAtStep simulation.
  const { failAtStep } = ctx;
  const executed: RecoveryStep[] = [];
  let failed = false;

  for (let i = 0; i < recipe.steps.length; i++) {
    if (failAtStep === i) {
      failed = true;
      break;
    }
    executed.push(recipe.steps[i]);
  }

  let result: RecoveryResult;
  if (failed) {
    const remaining = recipe.steps.slice(executed.length);
    if (executed.length === 0) {
      result = {
        kind: "escalation_required",
        reason: `recovery failed at first step for ${scenario}`,
      };
    } else {
      result = { kind: "partial_recovery", recovered: executed, remaining };
    }
  } else {
    result = { kind: "recovered", stepsTaken: recipe.steps.length };
  }

  ctx.events.push({ kind: "recovery_attempted", scenario, recipe, result });

  switch (result.kind) {
    case "recovered":
      ctx.events.push({ kind: "recovery_succeeded" });
      break;
    case "partial_recovery":
      ctx.events.push({ kind: "recovery_failed" });
      break;
    case "escalation_required":
      ctx.events.push({ kind: "escalated" });
      break;
  }

  return result;
}
