// Config diagnostics — validates a parsed config object against the known schema.
// Ported from claw-rust/crates/runtime/src/config_validate.rs (adapted for Solarcido's config shape).
// Pure module: no filesystem I/O, no imports from other src/ modules.

/** A diagnostic emitted when a config object contains a suspect field. */
export type ConfigDiagnostic =
  | { kind: "unknown-key"; key: string; suggestion?: string }
  | { kind: "wrong-type"; key: string; expected: string; got: string }
  | { kind: "deprecated"; key: string; replacement?: string };

// ---------------------------------------------------------------------------
// Levenshtein distance (pure, small)
// ---------------------------------------------------------------------------

/** Compute the Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array<number>(b.length + 1);

  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + cost);
    }
    prev.splice(0, prev.length, ...curr);
  }

  return prev[b.length];
}

/** Return the closest known key if it is within distance 3, otherwise undefined. */
function suggestKey(input: string, knownKeys: readonly string[]): string | undefined {
  const inputLower = input.toLowerCase();
  let best: string | undefined;
  let bestDist = 4; // threshold: suggest only if distance <= 3

  for (const key of knownKeys) {
    const dist = levenshtein(inputLower, key.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Type validation for the known config shape
// ---------------------------------------------------------------------------

const REASONING_EFFORT_VALUES = new Set(["low", "medium", "high"]);
const APPROVAL_POLICY_VALUES = new Set(["never", "on-failure", "on-request"]);
// Exactly the two valid sandbox modes (no danger-full-access in config)
const SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

/** Validate the value of a known config key; returns a wrong-type diagnostic or undefined. */
function checkValueType(
  key: string,
  value: unknown,
): { expected: string; got: string } | undefined {
  switch (key) {
    case "model":
      if (typeof value === "string") return undefined;
      return { expected: "string", got: typeof value };

    case "reasoningEffort":
      if (typeof value === "string" && REASONING_EFFORT_VALUES.has(value)) return undefined;
      if (typeof value !== "string") return { expected: "low|medium|high", got: typeof value };
      return { expected: "low|medium|high", got: `"${value}"` };

    case "approvalPolicy":
      if (typeof value === "string" && APPROVAL_POLICY_VALUES.has(value)) return undefined;
      if (typeof value !== "string") return { expected: "never|on-failure|on-request", got: typeof value };
      return { expected: "never|on-failure|on-request", got: `"${value}"` };

    case "sandbox":
      if (typeof value === "string" && SANDBOX_VALUES.has(value)) return undefined;
      if (typeof value !== "string") return { expected: "read-only|workspace-write", got: typeof value };
      return { expected: "read-only|workspace-write", got: `"${value}"` };

    case "quiet":
      if (typeof value === "boolean") return undefined;
      return { expected: "boolean", got: typeof value };

    default:
      // Unknown key — handled separately
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Deprecated keys (flag for diagnostics; actual rejection is done upstream)
// ---------------------------------------------------------------------------

const DEPRECATED_KEYS: ReadonlyMap<string, string | undefined> = new Map([
  // maxSteps is already rejected by parseConfigKey upstream; we only flag it here
  ["maxSteps", undefined],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed config object and return a list of diagnostics.
 *
 * @param parsed     - The config object to validate (Record<string, unknown>).
 * @param knownKeys  - The list of valid config keys (pass CONFIG_KEYS from config.ts).
 *
 * Checks performed:
 *  - unknown-key: key not in knownKeys → suggests nearest key via Levenshtein (distance ≤ 3)
 *  - wrong-type:  known key has a value of the wrong type or invalid enum value
 *  - deprecated:  key is in the deprecated list (e.g. maxSteps)
 */
export function validateConfigDiagnostics(
  parsed: Record<string, unknown>,
  knownKeys: readonly string[],
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    // Deprecated check first — these are not in knownKeys
    if (DEPRECATED_KEYS.has(key)) {
      diagnostics.push({
        kind: "deprecated",
        key,
        replacement: DEPRECATED_KEYS.get(key),
      });
      continue;
    }

    if (!knownKeys.includes(key)) {
      // Unknown key — try to suggest a close match
      const suggestion = suggestKey(key, knownKeys);
      diagnostics.push({ kind: "unknown-key", key, ...(suggestion !== undefined ? { suggestion } : {}) });
      continue;
    }

    // Known key — validate its value type
    const typeError = checkValueType(key, value);
    if (typeError !== undefined) {
      diagnostics.push({ kind: "wrong-type", key, ...typeError });
    }
  }

  return diagnostics;
}
