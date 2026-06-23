import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGreenContract,
  greenLevelSatisfies,
  isGreenContractSatisfied,
  makeGreenContract,
} from "../dist/runtime/green-contract.js";

// ---------------------------------------------------------------------------
// greenLevelSatisfies — ordering
// ---------------------------------------------------------------------------

test("greenLevelSatisfies: same level satisfies", () => {
  assert.equal(greenLevelSatisfies("package", "package"), true);
  assert.equal(greenLevelSatisfies("targeted_tests", "targeted_tests"), true);
  assert.equal(greenLevelSatisfies("merge_ready", "merge_ready"), true);
});

test("greenLevelSatisfies: higher level satisfies lower requirement", () => {
  assert.equal(greenLevelSatisfies("targeted_tests", "workspace"), true);
  assert.equal(greenLevelSatisfies("targeted_tests", "merge_ready"), true);
  assert.equal(greenLevelSatisfies("package", "workspace"), true);
  assert.equal(greenLevelSatisfies("package", "merge_ready"), true);
  assert.equal(greenLevelSatisfies("workspace", "merge_ready"), true);
});

test("greenLevelSatisfies: lower level does not satisfy higher requirement", () => {
  assert.equal(greenLevelSatisfies("workspace", "package"), false);
  assert.equal(greenLevelSatisfies("workspace", "targeted_tests"), false);
  assert.equal(greenLevelSatisfies("merge_ready", "targeted_tests"), false);
  assert.equal(greenLevelSatisfies("merge_ready", "workspace"), false);
  assert.equal(greenLevelSatisfies("package", "targeted_tests"), false);
});

// ---------------------------------------------------------------------------
// makeGreenContract / evaluateGreenContract
// ---------------------------------------------------------------------------

test("evaluateGreenContract: exact match is satisfied", () => {
  const contract = makeGreenContract("package");
  const outcome = evaluateGreenContract(contract, "package");
  assert.equal(outcome.outcome, "satisfied");
  assert.equal(outcome.requiredLevel, "package");
  assert.equal(outcome.observedLevel, "package");
  assert.equal(isGreenContractSatisfied(outcome), true);
});

test("evaluateGreenContract: higher level satisfies contract", () => {
  const contract = makeGreenContract("targeted_tests");
  const outcome = evaluateGreenContract(contract, "workspace");
  assert.equal(outcome.outcome, "satisfied");
  assert.equal(isGreenContractSatisfied(outcome), true);
});

test("evaluateGreenContract: lower level does not satisfy contract", () => {
  const contract = makeGreenContract("workspace");
  const outcome = evaluateGreenContract(contract, "package");
  assert.equal(outcome.outcome, "unsatisfied");
  assert.equal(outcome.requiredLevel, "workspace");
  assert.equal(outcome.observedLevel, "package");
  assert.equal(isGreenContractSatisfied(outcome), false);
});

test("evaluateGreenContract: undefined observedLevel is unsatisfied", () => {
  const contract = makeGreenContract("merge_ready");
  const outcome = evaluateGreenContract(contract, undefined);
  assert.equal(outcome.outcome, "unsatisfied");
  assert.equal(outcome.requiredLevel, "merge_ready");
  assert.equal(outcome.observedLevel, undefined);
  assert.equal(isGreenContractSatisfied(outcome), false);
});

test("evaluateGreenContract: merge_ready requires merge_ready exactly", () => {
  const contract = makeGreenContract("merge_ready");
  assert.equal(evaluateGreenContract(contract, "workspace").outcome, "unsatisfied");
  assert.equal(evaluateGreenContract(contract, "merge_ready").outcome, "satisfied");
});

// ---------------------------------------------------------------------------
// GreenLevel ordering completeness
// ---------------------------------------------------------------------------

test("ordering is total and transitive across all levels", () => {
  const levels = ["targeted_tests", "package", "workspace", "merge_ready"];
  for (let i = 0; i < levels.length; i++) {
    for (let j = 0; j < levels.length; j++) {
      const required = levels[i];
      const observed = levels[j];
      const expected = j >= i;
      assert.equal(
        greenLevelSatisfies(required, observed),
        expected,
        `greenLevelSatisfies(${required}, ${observed}) should be ${expected}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// isGreenContractSatisfied convenience
// ---------------------------------------------------------------------------

test("isGreenContractSatisfied returns true only for satisfied outcomes", () => {
  assert.equal(
    isGreenContractSatisfied({ outcome: "satisfied", requiredLevel: "package", observedLevel: "workspace" }),
    true,
  );
  assert.equal(
    isGreenContractSatisfied({ outcome: "unsatisfied", requiredLevel: "workspace", observedLevel: undefined }),
    false,
  );
  assert.equal(
    isGreenContractSatisfied({ outcome: "unsatisfied", requiredLevel: "workspace", observedLevel: "package" }),
    false,
  );
});
