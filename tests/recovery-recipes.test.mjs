import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_FAILURE_SCENARIOS,
  attemptCount,
  attemptRecovery,
  makeRecoveryContext,
  recipeFor,
} from "../dist/runtime/recovery-recipes.js";

// ---------------------------------------------------------------------------
// recipeFor — each scenario has a valid recipe
// ---------------------------------------------------------------------------

test("each scenario has a matching recipe with at least one step", () => {
  for (const scenario of ALL_FAILURE_SCENARIOS) {
    const recipe = recipeFor(scenario);
    assert.equal(recipe.scenario, scenario, `scenario field should match for ${scenario}`);
    assert.ok(recipe.steps.length >= 1, `recipe for ${scenario} should have at least one step`);
    assert.ok(recipe.maxAttempts >= 1, `recipe for ${scenario} should allow at least one attempt`);
  }
});

test("stale_branch recipe has rebase_branch then clean_build", () => {
  const recipe = recipeFor("stale_branch");
  assert.equal(recipe.steps.length, 2);
  assert.equal(recipe.steps[0].kind, "rebase_branch");
  assert.equal(recipe.steps[1].kind, "clean_build");
  assert.equal(recipe.escalationPolicy, "alert_human");
});

test("partial_plugin_startup recipe has restart_plugin then retry_mcp_handshake", () => {
  const recipe = recipeFor("partial_plugin_startup");
  assert.equal(recipe.steps.length, 2);
  assert.equal(recipe.steps[0].kind, "restart_plugin");
  assert.equal(recipe.steps[1].kind, "retry_mcp_handshake");
  assert.equal(recipe.escalationPolicy, "log_and_continue");
});

test("mcp_handshake_failure uses abort escalation policy", () => {
  const recipe = recipeFor("mcp_handshake_failure");
  assert.equal(recipe.escalationPolicy, "abort");
  assert.equal(recipe.maxAttempts, 1);
  assert.equal(recipe.steps[0].kind, "retry_mcp_handshake");
});

test("provider_failure recipe uses restart_worker step", () => {
  const recipe = recipeFor("provider_failure");
  assert.equal(recipe.steps[0].kind, "restart_worker");
  assert.equal(recipe.escalationPolicy, "alert_human");
  assert.equal(recipe.maxAttempts, 1);
});

test("trust_prompt_unresolved recipe accepts trust prompt", () => {
  const recipe = recipeFor("trust_prompt_unresolved");
  assert.equal(recipe.steps[0].kind, "accept_trust_prompt");
  assert.equal(recipe.escalationPolicy, "alert_human");
});

test("prompt_misdelivery recipe redirects to agent", () => {
  const recipe = recipeFor("prompt_misdelivery");
  assert.equal(recipe.steps[0].kind, "redirect_prompt_to_agent");
  assert.equal(recipe.escalationPolicy, "alert_human");
});

test("compile_red_cross_crate recipe runs clean_build", () => {
  const recipe = recipeFor("compile_red_cross_crate");
  assert.equal(recipe.steps[0].kind, "clean_build");
  assert.equal(recipe.maxAttempts, 1);
});

// ---------------------------------------------------------------------------
// attemptRecovery — successful single-step recovery
// ---------------------------------------------------------------------------

test("successful recovery returns recovered and emits events", () => {
  const ctx = makeRecoveryContext();
  const result = attemptRecovery("trust_prompt_unresolved", ctx);

  assert.equal(result.kind, "recovered");
  assert.equal(result.stepsTaken, 1);
  assert.equal(ctx.events.length, 2);
  assert.equal(ctx.events[0].kind, "recovery_attempted");
  assert.equal(ctx.events[0].scenario, "trust_prompt_unresolved");
  assert.equal(ctx.events[1].kind, "recovery_succeeded");
});

test("successful multi-step recovery reports correct steps taken", () => {
  const ctx = makeRecoveryContext();
  const result = attemptRecovery("stale_branch", ctx);
  assert.equal(result.kind, "recovered");
  assert.equal(result.stepsTaken, 2);
});

// ---------------------------------------------------------------------------
// attemptRecovery — escalation after max attempts
// ---------------------------------------------------------------------------

test("escalation after max attempts exceeded", () => {
  const ctx = makeRecoveryContext();

  const first = attemptRecovery("prompt_misdelivery", ctx);
  assert.equal(first.kind, "recovered");

  const second = attemptRecovery("prompt_misdelivery", ctx);
  assert.equal(second.kind, "escalation_required");
  assert.ok(second.reason.includes("max recovery attempts"));

  // attempt count stays at 1 (the successful first attempt)
  assert.equal(attemptCount(ctx, "prompt_misdelivery"), 1);
  assert.ok(ctx.events.some((e) => e.kind === "escalated"));
});

test("provider_failure succeeds then escalates on second call", () => {
  const ctx = makeRecoveryContext();
  const first = attemptRecovery("provider_failure", ctx);
  assert.equal(first.kind, "recovered");

  const second = attemptRecovery("provider_failure", ctx);
  assert.equal(second.kind, "escalation_required");
  assert.ok(ctx.events.some((e) => e.kind === "escalated"));
});

// ---------------------------------------------------------------------------
// attemptRecovery — partial / first-step failure
// ---------------------------------------------------------------------------

test("partial recovery when step fails midway", () => {
  // partial_plugin_startup has 2 steps; fail at index 1
  const ctx = makeRecoveryContext(1);
  const result = attemptRecovery("partial_plugin_startup", ctx);

  assert.equal(result.kind, "partial_recovery");
  assert.equal(result.recovered.length, 1);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.recovered[0].kind, "restart_plugin");
  assert.equal(result.remaining[0].kind, "retry_mcp_handshake");
  assert.ok(ctx.events.some((e) => e.kind === "recovery_failed"));
});

test("first step failure escalates immediately", () => {
  const ctx = makeRecoveryContext(0);
  const result = attemptRecovery("compile_red_cross_crate", ctx);

  assert.equal(result.kind, "escalation_required");
  assert.ok(result.reason.includes("failed at first step"));
  assert.ok(ctx.events.some((e) => e.kind === "escalated"));
});

// ---------------------------------------------------------------------------
// attemptRecovery — structured event content
// ---------------------------------------------------------------------------

test("emitted events include structured attempt data", () => {
  const ctx = makeRecoveryContext();
  attemptRecovery("mcp_handshake_failure", ctx);

  const attempted = ctx.events.find((e) => e.kind === "recovery_attempted");
  assert.ok(attempted, "should have emitted recovery_attempted");
  assert.equal(attempted.scenario, "mcp_handshake_failure");
  assert.ok(attempted.recipe.steps.length > 0);
  assert.equal(attempted.result.kind, "recovered");
});

// ---------------------------------------------------------------------------
// RecoveryContext — attempt tracking
// ---------------------------------------------------------------------------

test("recovery context tracks attempts per scenario independently", () => {
  const ctx = makeRecoveryContext();
  assert.equal(attemptCount(ctx, "stale_branch"), 0);

  attemptRecovery("stale_branch", ctx);
  assert.equal(attemptCount(ctx, "stale_branch"), 1);
  assert.equal(attemptCount(ctx, "prompt_misdelivery"), 0);
});

test("makeRecoveryContext with no failAtStep succeeds all steps", () => {
  const ctx = makeRecoveryContext();
  const result = attemptRecovery("stale_branch", ctx);
  assert.equal(result.kind, "recovered");
  assert.equal(result.stepsTaken, 2);
});

test("attempt count is not incremented when escalating due to max attempts", () => {
  const ctx = makeRecoveryContext();
  attemptRecovery("trust_prompt_unresolved", ctx); // attempt 1 → succeeds
  assert.equal(attemptCount(ctx, "trust_prompt_unresolved"), 1);

  attemptRecovery("trust_prompt_unresolved", ctx); // attempt 2 → escalates
  // count stays at 1 — the escalation path does not increment
  assert.equal(attemptCount(ctx, "trust_prompt_unresolved"), 1);
});

// ---------------------------------------------------------------------------
// ALL_FAILURE_SCENARIOS completeness
// ---------------------------------------------------------------------------

test("ALL_FAILURE_SCENARIOS includes all expected provider-neutral scenarios", () => {
  const expected = [
    "trust_prompt_unresolved",
    "prompt_misdelivery",
    "stale_branch",
    "compile_red_cross_crate",
    "mcp_handshake_failure",
    "partial_plugin_startup",
    "provider_failure",
  ];
  assert.deepEqual([...ALL_FAILURE_SCENARIOS], expected);
});
