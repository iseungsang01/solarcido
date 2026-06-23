import assert from "node:assert/strict";
import test from "node:test";

import { compressSummary } from "../dist/runtime/summary-compression.js";
import {
  buildCompactionPreamble,
  compactMessageCount,
  formatCompactSummary,
  shouldCompact,
} from "../dist/runtime/compaction.js";

// ---------------------------------------------------------------------------
// compressSummary — line-cap and char-cap
// ---------------------------------------------------------------------------

test("compressSummary caps lines to maxLines and sets truncated", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const input = lines.join("\n");

  const result = compressSummary(input, { maxLines: 40, maxChars: 100_000 });

  assert.ok(result.truncated, "truncated should be true when lines were dropped");
  assert.ok(
    result.text.split("\n").length <= 41, // 40 content lines + possibly 1 omission notice
    `line count should be <= 41, got ${result.text.split("\n").length}`,
  );
});

test("compressSummary caps total chars to maxChars and sets truncated", () => {
  const input = "A".repeat(200) + "\n" + "B".repeat(200);

  const result = compressSummary(input, { maxChars: 100, maxLines: 1000 });

  assert.ok(result.truncated, "truncated should be true when chars exceeded budget");
  assert.ok(
    result.text.length <= 120, // allow some headroom for omission notice
    `output chars should be within budget, got ${result.text.length}`,
  );
});

// ---------------------------------------------------------------------------
// compressSummary — deduplication
// ---------------------------------------------------------------------------

test("compressSummary deduplicates repeated identical lines", () => {
  const input = "- Scope: work done.\n- Scope: work done.\n- Scope: work done.\n- Current work: finish port.";

  const result = compressSummary(input);

  const lines = result.text.split("\n").filter((l) => !l.startsWith("- …"));
  const scopeLines = lines.filter((l) => l.includes("Scope: work done."));
  assert.equal(scopeLines.length, 1, "duplicate lines should be collapsed to one");
  assert.ok(result.truncated, "truncated should be true when dupes were removed");
});

test("compressSummary deduplication is case-insensitive", () => {
  const input = "Conversation summary:\nconversation summary:\nCONVERSATION SUMMARY:";

  const result = compressSummary(input);

  const lines = result.text.split("\n").filter((l) => !l.startsWith("- …"));
  assert.equal(lines.length, 1, "case variants should be deduplicated to one line");
});

test("compressSummary returns empty text and truncated=false for empty input", () => {
  const result = compressSummary("");
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
});

test("compressSummary does not set truncated when nothing was dropped", () => {
  const input = "Summary:\n- Scope: two messages compacted.";

  const result = compressSummary(input, { maxLines: 100, maxChars: 10_000 });

  assert.equal(result.truncated, false);
  assert.equal(result.text, input);
});

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

test("shouldCompact returns true when estimated tokens exceed maxTokens", () => {
  assert.equal(shouldCompact(10_001, 10_000), true);
  assert.equal(shouldCompact(10_000, 10_000), false);
  assert.equal(shouldCompact(9_999, 10_000), false);
});

test("shouldCompact returns false when estimatedTokens equals maxTokens exactly", () => {
  assert.equal(shouldCompact(500, 500), false);
});

test("shouldCompact returns false when well under budget", () => {
  assert.equal(shouldCompact(0, 10_000), false);
});

// ---------------------------------------------------------------------------
// formatCompactSummary
// ---------------------------------------------------------------------------

test("formatCompactSummary strips <analysis> blocks", () => {
  const input = "<analysis>scratch notes</analysis>\n<summary>Kept work</summary>";

  const result = formatCompactSummary(input);

  assert.ok(!result.includes("<analysis>"), "analysis block should be stripped");
  assert.ok(!result.includes("scratch notes"), "analysis content should be gone");
});

test("formatCompactSummary unwraps <summary> tag into heading", () => {
  const input = "<summary>Kept work</summary>";

  const result = formatCompactSummary(input);

  assert.ok(result.includes("Summary:"), "should contain Summary: heading");
  assert.ok(result.includes("Kept work"), "content should be preserved");
  assert.ok(!result.includes("<summary>"), "xml tags should be removed");
});

test("formatCompactSummary matches upstream behaviour (analysis + summary)", () => {
  const input = "<analysis>scratch</analysis>\n<summary>Kept work</summary>";

  assert.equal(formatCompactSummary(input), "Summary:\nKept work");
});

test("formatCompactSummary collapses repeated blank lines", () => {
  const input = "line one\n\n\n\nline two";

  const result = formatCompactSummary(input);

  assert.ok(!result.includes("\n\n\n"), "should not have triple blank lines");
  assert.ok(result.includes("line one"), "content preserved");
  assert.ok(result.includes("line two"), "content preserved");
});

test("formatCompactSummary returns a non-empty string for plain text", () => {
  const input = "Conversation summary:\n- Scope: 4 messages compacted.";
  const result = formatCompactSummary(input);
  assert.ok(result.length > 0);
  assert.equal(result, input.trim());
});

// ---------------------------------------------------------------------------
// buildCompactionPreamble
// ---------------------------------------------------------------------------

test("buildCompactionPreamble embeds the summary in output", () => {
  const summary = "- Scope: 10 messages compacted.";
  const result = buildCompactionPreamble(summary, false, false);
  assert.ok(result.includes(summary), "preamble should contain the summary text");
});

test("buildCompactionPreamble returns a non-empty stable string", () => {
  const result1 = buildCompactionPreamble("test summary", true, true);
  const result2 = buildCompactionPreamble("test summary", true, true);
  assert.equal(result1, result2, "output should be deterministic");
  assert.ok(result1.length > 0);
});

test("buildCompactionPreamble includes recent-messages note when requested", () => {
  const result = buildCompactionPreamble("s", true, true);
  assert.ok(result.includes("Recent messages are preserved verbatim."));
});

test("buildCompactionPreamble omits recent-messages note when not requested", () => {
  const result = buildCompactionPreamble("s", false, false);
  assert.ok(!result.includes("Recent messages are preserved verbatim."));
});

test("buildCompactionPreamble uses provider-neutral language (no Anthropic branding)", () => {
  const result = buildCompactionPreamble("summary text", true, true);
  assert.ok(!result.toLowerCase().includes("anthropic"), "should not mention Anthropic");
  assert.ok(!result.toLowerCase().includes("claude"), "should not mention Claude");
});

// ---------------------------------------------------------------------------
// compactMessageCount
// ---------------------------------------------------------------------------

test("compactMessageCount returns messages to remove", () => {
  assert.equal(compactMessageCount(10, 1, 4), 5);
  assert.equal(compactMessageCount(10, 0, 0), 10);
  assert.equal(compactMessageCount(4, 2, 2), 0);
});

test("compactMessageCount never returns negative", () => {
  assert.equal(compactMessageCount(2, 5, 5), 0);
  assert.equal(compactMessageCount(0, 0, 0), 0);
});
