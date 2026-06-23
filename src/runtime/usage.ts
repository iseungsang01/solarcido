// Token usage tracking and cost estimation for Solarcido.
// Ported from claw-rust/crates/runtime/src/usage.rs.
// Pure module: no filesystem I/O, no imports from other src/ modules.
// Cache-token columns from the Rust source are dropped (Solar does not expose them).

/** Token counts for a single turn or accumulated session. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Per-million-token pricing in USD. */
export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

// TODO: confirm Solar pricing — these are PLACEHOLDER values.
// Upstage does not publish a standard per-token price list; adjust once confirmed.
const PRICING_TABLE: ReadonlyArray<[string, ModelPricing]> = [
  [
    "solar-pro3-260323",
    { inputPerMillion: 0.5, outputPerMillion: 1.5 }, // TODO: confirm Solar pricing
  ],
  [
    "solar-pro2",
    { inputPerMillion: 0.5, outputPerMillion: 1.5 }, // TODO: confirm Solar pricing
  ],
  [
    "solar-mini",
    { inputPerMillion: 0.2, outputPerMillion: 0.6 }, // TODO: confirm Solar pricing
  ],
];

/**
 * Return pricing metadata for a known Solar model, or null for an unknown model.
 *
 * Matching is exact (lowercased). Unknown models return null so callers can
 * decide whether to fall back to a default or suppress cost display.
 */
export function pricingForModel(model: string): ModelPricing | null {
  const normalized = model.toLowerCase().trim();
  for (const [key, pricing] of PRICING_TABLE) {
    if (normalized === key || normalized.startsWith(key)) {
      return pricing;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Return a zero-valued TokenUsage. */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** Add two TokenUsage values together, summing each field. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Estimate the dollar cost of a TokenUsage at the given pricing.
 *
 * Uses inputTokens and outputTokens; totalTokens is informational only.
 */
export function estimateCostUsd(usage: TokenUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * Format a dollar amount to 4 decimal places, e.g. "$0.0123".
 *
 * Matches the Rust `format_usd` output format used in CLI summaries.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// OpenAI SDK usage shape normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize the OpenAI-SDK `usage` field from a chat completion response into
 * a TokenUsage.
 *
 * Maps:
 *   prompt_tokens     → inputTokens
 *   completion_tokens → outputTokens
 *   total_tokens      → totalTokens (falls back to input + output when absent)
 *
 * Missing or undefined fields default to 0.
 */
export function normalizeUsage(
  raw:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): TokenUsage {
  if (raw === undefined) {
    return emptyUsage();
  }
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  const totalTokens = raw.total_tokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}
