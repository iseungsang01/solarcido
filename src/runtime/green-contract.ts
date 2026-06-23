// Green contract: required vs observed green level evaluation.
// Pure module — no I/O, no Date.now(), no Math.random().

// ---------------------------------------------------------------------------
// GreenLevel — ordered enum via discriminated union + total ordering
// ---------------------------------------------------------------------------

/**
 * Ordered levels of test-suite confidence.
 * Higher levels subsume lower ones (workspace >= package >= targeted_tests).
 */
export type GreenLevel =
  | "targeted_tests"
  | "package"
  | "workspace"
  | "merge_ready";

const GREEN_LEVEL_ORDER: Record<GreenLevel, number> = {
  targeted_tests: 0,
  package: 1,
  workspace: 2,
  merge_ready: 3,
};

/** Returns true if `observed` satisfies `required` (observed >= required). */
export function greenLevelSatisfies(required: GreenLevel, observed: GreenLevel): boolean {
  return GREEN_LEVEL_ORDER[observed] >= GREEN_LEVEL_ORDER[required];
}

// ---------------------------------------------------------------------------
// GreenContract
// ---------------------------------------------------------------------------

export interface GreenContract {
  requiredLevel: GreenLevel;
}

export function makeGreenContract(requiredLevel: GreenLevel): GreenContract {
  return { requiredLevel };
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type GreenContractOutcome =
  | { outcome: "satisfied"; requiredLevel: GreenLevel; observedLevel: GreenLevel }
  | { outcome: "unsatisfied"; requiredLevel: GreenLevel; observedLevel: GreenLevel | undefined };

/**
 * Evaluate whether the observed level satisfies the contract's requirement.
 * Pass `undefined` for `observedLevel` when no green signal has been received.
 */
export function evaluateGreenContract(
  contract: GreenContract,
  observedLevel: GreenLevel | undefined,
): GreenContractOutcome {
  if (
    observedLevel !== undefined &&
    greenLevelSatisfies(contract.requiredLevel, observedLevel)
  ) {
    return {
      outcome: "satisfied",
      requiredLevel: contract.requiredLevel,
      observedLevel,
    };
  }
  return {
    outcome: "unsatisfied",
    requiredLevel: contract.requiredLevel,
    observedLevel,
  };
}

export function isGreenContractSatisfied(outcome: GreenContractOutcome): boolean {
  return outcome.outcome === "satisfied";
}
