/**
 * Pure, synchronous helpers for compressing and deduplicating compaction summaries.
 * No model calls, no network I/O. Ported from claw-rust/crates/runtime/src/summary_compression.rs.
 */

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_LINES = 40;
const DEFAULT_MAX_LINE_CHARS = 160;

export interface CompressSummaryOptions {
  /** Maximum total character count for the compressed output. Default: 4000. */
  maxChars?: number;
  /** Maximum number of lines in the compressed output. Default: 40. */
  maxLines?: number;
  /** Maximum characters per individual line before truncation. Default: 160. */
  maxLineChars?: number;
}

export interface CompressSummaryResult {
  text: string;
  /** True when any content was dropped (lines capped, chars truncated, or dupes removed). */
  truncated: boolean;
}

/**
 * Compresses a summary string by:
 * 1. Deduplicating consecutive identical lines (case-insensitive, whitespace-normalised).
 * 2. Truncating individual lines that exceed maxLineChars.
 * 3. Capping the output to maxLines and maxChars, preferring higher-priority lines.
 *
 * Returns `{ text, truncated }` where `truncated` is true whenever anything was dropped.
 */
export function compressSummary(
  text: string,
  opts?: CompressSummaryOptions,
): CompressSummaryResult {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = opts?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  const original = text;

  // Step 1: normalise and deduplicate lines.
  const seen = new Set<string>();
  const normalised: string[] = [];
  let removedDupes = 0;

  for (const raw of text.split("\n")) {
    const collapsed = collapseInlineWhitespace(raw);
    if (collapsed === "") continue;

    const truncatedLine = truncateLine(collapsed, maxLineChars);
    const key = dedupKey(truncatedLine);
    if (seen.has(key)) {
      removedDupes++;
      continue;
    }
    seen.add(key);
    normalised.push(truncatedLine);
  }

  if (normalised.length === 0 || maxChars === 0 || maxLines === 0) {
    return { text: "", truncated: original.trim() !== "" };
  }

  // Step 2: select lines by priority until budget is exhausted.
  const selected = selectLines(normalised, maxLines, maxChars);

  // Step 3: append omission notice when lines were dropped.
  const omitted = normalised.length - selected.length;
  if (omitted > 0) {
    const notice = `- … ${omitted} additional line(s) omitted.`;
    if (
      selected.length < maxLines &&
      joinedCharCount([...selected, notice]) <= maxChars
    ) {
      selected.push(notice);
    }
  }

  const result = selected.join("\n");
  const truncated =
    removedDupes > 0 || omitted > 0 || result !== original.trim();

  return { text: result, truncated };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collapseInlineWhitespace(line: string): string {
  return line.split(/\s+/).filter(Boolean).join(" ");
}

function truncateLine(line: string, maxChars: number): string {
  if (maxChars === 0) return "…";
  if ([...line].length <= maxChars) return line;
  // Reserve one character for the ellipsis.
  return [...line].slice(0, maxChars - 1).join("") + "…";
}

function dedupKey(line: string): string {
  return line.toLowerCase();
}

/** Priority 0 = highest (always keep first). */
function linePriority(line: string): number {
  if (
    line === "Summary:" ||
    line === "Conversation summary:" ||
    isCoreDetail(line)
  ) {
    return 0;
  }
  if (isSectionHeader(line)) return 1;
  if (line.startsWith("- ") || line.startsWith("  - ")) return 2;
  return 3;
}

function isCoreDetail(line: string): boolean {
  return [
    "- Scope:",
    "- Current work:",
    "- Pending work:",
    "- Key files referenced:",
    "- Tools mentioned:",
    "- Recent user requests:",
    "- Previously compacted context:",
    "- Newly compacted context:",
  ].some((prefix) => line.startsWith(prefix));
}

function isSectionHeader(line: string): boolean {
  return line.endsWith(":");
}

function joinedCharCount(lines: string[]): number {
  const total = lines.reduce((sum, l) => sum + [...l].length, 0);
  return total + Math.max(0, lines.length - 1); // account for \n separators
}

/**
 * Greedily selects lines in priority order until maxLines or maxChars is
 * reached, preserving the original order in the output.
 */
function selectLines(
  lines: string[],
  maxLines: number,
  maxChars: number,
): string[] {
  const selectedIndexes = new Set<number>();

  for (let priority = 0; priority <= 3; priority++) {
    for (let i = 0; i < lines.length; i++) {
      if (selectedIndexes.has(i)) continue;
      if (linePriority(lines[i]) !== priority) continue;

      const candidate = [
        ...Array.from(selectedIndexes)
          .sort((a, b) => a - b)
          .map((idx) => lines[idx]),
        lines[i],
      ];

      if (candidate.length > maxLines) continue;
      if (joinedCharCount(candidate) > maxChars) continue;

      selectedIndexes.add(i);
    }
  }

  return Array.from(selectedIndexes)
    .sort((a, b) => a - b)
    .map((i) => lines[i]);
}
