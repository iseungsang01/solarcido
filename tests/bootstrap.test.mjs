import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapPlanFromPhases,
  solarcidoDefaultBootstrapPlan,
} from "../dist/runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// bootstrapPlanFromPhases
// ---------------------------------------------------------------------------

test("bootstrapPlanFromPhases: empty input yields empty plan", () => {
  const plan = bootstrapPlanFromPhases([]);
  assert.equal(plan.phases.length, 0);
});

test("bootstrapPlanFromPhases: single phase is kept", () => {
  const plan = bootstrapPlanFromPhases(["cli-entry"]);
  assert.deepEqual(plan.phases, ["cli-entry"]);
});

test("bootstrapPlanFromPhases: deduplicates while preserving first-occurrence order", () => {
  const plan = bootstrapPlanFromPhases([
    "cli-entry",
    "fast-path-version",
    "cli-entry",        // duplicate — should be dropped
    "main-runtime",
    "fast-path-version", // duplicate — should be dropped
  ]);
  assert.deepEqual(plan.phases, ["cli-entry", "fast-path-version", "main-runtime"]);
});

test("bootstrapPlanFromPhases: no duplicates in input passes through unchanged", () => {
  const input = ["cli-entry", "startup-profiler", "main-runtime"];
  const plan = bootstrapPlanFromPhases(input);
  assert.deepEqual([...plan.phases], input);
});

test("bootstrapPlanFromPhases: all-same phases collapses to one", () => {
  const plan = bootstrapPlanFromPhases(["main-runtime", "main-runtime", "main-runtime"]);
  assert.deepEqual(plan.phases, ["main-runtime"]);
});

// ---------------------------------------------------------------------------
// solarcidoDefaultBootstrapPlan
// ---------------------------------------------------------------------------

const EXPECTED_DEFAULT_PHASES = [
  "cli-entry",
  "fast-path-version",
  "startup-profiler",
  "system-prompt-fast-path",
  "chrome-mcp-fast-path",
  "daemon-worker-fast-path",
  "bridge-fast-path",
  "daemon-fast-path",
  "background-session-fast-path",
  "template-fast-path",
  "environment-runner-fast-path",
  "main-runtime",
];

test("solarcidoDefaultBootstrapPlan: returns all 12 phases in canonical order", () => {
  const plan = solarcidoDefaultBootstrapPlan();
  assert.deepEqual([...plan.phases], EXPECTED_DEFAULT_PHASES);
});

test("solarcidoDefaultBootstrapPlan: contains no duplicates", () => {
  const plan = solarcidoDefaultBootstrapPlan();
  const unique = new Set(plan.phases);
  assert.equal(unique.size, plan.phases.length);
});

test("solarcidoDefaultBootstrapPlan: starts with cli-entry and ends with main-runtime", () => {
  const plan = solarcidoDefaultBootstrapPlan();
  assert.equal(plan.phases[0], "cli-entry");
  assert.equal(plan.phases[plan.phases.length - 1], "main-runtime");
});

test("solarcidoDefaultBootstrapPlan: repeated calls return equivalent plans", () => {
  const a = solarcidoDefaultBootstrapPlan();
  const b = solarcidoDefaultBootstrapPlan();
  assert.deepEqual([...a.phases], [...b.phases]);
});
