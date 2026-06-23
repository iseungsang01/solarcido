import assert from "node:assert/strict";
import test from "node:test";

import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  formatUsd,
  normalizeUsage,
  pricingForModel,
} from "../dist/runtime/usage.js";

// ---------------------------------------------------------------------------
// pricingForModel
// ---------------------------------------------------------------------------

test("pricingForModel: solar-pro3-260323 returns non-null with positive numbers", () => {
  const pricing = pricingForModel("solar-pro3-260323");
  assert.notEqual(pricing, null);
  assert.ok(pricing.inputPerMillion > 0, "inputPerMillion must be positive");
  assert.ok(pricing.outputPerMillion > 0, "outputPerMillion must be positive");
});

test("pricingForModel: unknown-model returns null", () => {
  assert.equal(pricingForModel("unknown-model"), null);
});

test("pricingForModel: empty string returns null", () => {
  assert.equal(pricingForModel(""), null);
});

test("pricingForModel: case-insensitive match for solar-pro3-260323", () => {
  const pricing = pricingForModel("Solar-Pro3-260323");
  assert.notEqual(pricing, null);
});

// ---------------------------------------------------------------------------
// estimateCostUsd
// ---------------------------------------------------------------------------

test("estimateCostUsd: computes correct cost for known fixture", () => {
  // 1M input + 1M output at $0.50/$1.50 per million = $2.00
  const pricing = { inputPerMillion: 0.5, outputPerMillion: 1.5 };
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  const cost = estimateCostUsd(usage, pricing);
  assert.equal(cost, 2.0);
});

test("estimateCostUsd: zero usage yields $0", () => {
  const pricing = { inputPerMillion: 0.5, outputPerMillion: 1.5 };
  assert.equal(estimateCostUsd(emptyUsage(), pricing), 0);
});

test("estimateCostUsd: only input tokens", () => {
  const pricing = { inputPerMillion: 1.0, outputPerMillion: 2.0 };
  const usage = { inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 };
  // 0.5M * $1.0/M = $0.50
  assert.equal(estimateCostUsd(usage, pricing), 0.5);
});

test("estimateCostUsd: only output tokens", () => {
  const pricing = { inputPerMillion: 1.0, outputPerMillion: 2.0 };
  const usage = { inputTokens: 0, outputTokens: 250_000, totalTokens: 250_000 };
  // 0.25M * $2.0/M = $0.50
  assert.equal(estimateCostUsd(usage, pricing), 0.5);
});

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

test("addUsage: sums all fields correctly", () => {
  const a = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
  const b = { inputTokens: 200, outputTokens: 75, totalTokens: 275 };
  const result = addUsage(a, b);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 125);
  assert.equal(result.totalTokens, 425);
});

test("addUsage: adding emptyUsage is identity", () => {
  const a = { inputTokens: 42, outputTokens: 17, totalTokens: 59 };
  const result = addUsage(a, emptyUsage());
  assert.deepEqual(result, { inputTokens: 42, outputTokens: 17, totalTokens: 59 });
});

test("addUsage: two empty usages yields empty usage", () => {
  assert.deepEqual(addUsage(emptyUsage(), emptyUsage()), emptyUsage());
});

// ---------------------------------------------------------------------------
// normalizeUsage
// ---------------------------------------------------------------------------

test("normalizeUsage: maps prompt_tokens/completion_tokens/total_tokens", () => {
  const result = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.totalTokens, 150);
});

test("normalizeUsage: missing total_tokens falls back to input+output", () => {
  const result = normalizeUsage({ prompt_tokens: 80, completion_tokens: 20 });
  assert.equal(result.inputTokens, 80);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.totalTokens, 100);
});

test("normalizeUsage: missing prompt_tokens defaults to 0", () => {
  const result = normalizeUsage({ completion_tokens: 30, total_tokens: 30 });
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.totalTokens, 30);
});

test("normalizeUsage: missing completion_tokens defaults to 0", () => {
  const result = normalizeUsage({ prompt_tokens: 40, total_tokens: 40 });
  assert.equal(result.inputTokens, 40);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.totalTokens, 40);
});

test("normalizeUsage: undefined input returns emptyUsage", () => {
  assert.deepEqual(normalizeUsage(undefined), emptyUsage());
});

test("normalizeUsage: all fields missing defaults to all zeros", () => {
  assert.deepEqual(normalizeUsage({}), emptyUsage());
});

// ---------------------------------------------------------------------------
// formatUsd
// ---------------------------------------------------------------------------

test("formatUsd: formats to 4 decimal places with $ prefix", () => {
  assert.equal(formatUsd(0.0123), "$0.0123");
});

test("formatUsd: zero amount", () => {
  assert.equal(formatUsd(0), "$0.0000");
});

test("formatUsd: rounds to 4 dp", () => {
  assert.equal(formatUsd(1.23456789), "$1.2346");
});

test("formatUsd: large amount", () => {
  assert.equal(formatUsd(100), "$100.0000");
});

// ---------------------------------------------------------------------------
// Integration: pricingForModel + estimateCostUsd + formatUsd
// ---------------------------------------------------------------------------

test("integration: solar-pro3-260323 pricing produces expected format", () => {
  const pricing = pricingForModel("solar-pro3-260323");
  assert.notEqual(pricing, null);
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  const cost = estimateCostUsd(usage, pricing);
  const formatted = formatUsd(cost);
  // $0.50 + $1.50 = $2.00
  assert.equal(formatted, "$2.0000");
});
