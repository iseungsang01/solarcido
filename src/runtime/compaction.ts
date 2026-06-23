/**
 * Pure, synchronous compaction-decision helpers.
 * No model calls, no network I/O. Ported from claw-rust/crates/runtime/src/compact.rs
 * (pure/synchronous parts only).
 *
 * NOTE: These helpers are provider-neutral. Any Anthropic-specific phrasing
 * that existed in the Rust source has been replaced with generic continuation
 * language. The existing literal "Earlier tool transcript was compacted" in
 * src/runtime/conversation.ts is intentionally left untouched — that string
 * is managed by the live compaction path and is not changed here.
 */

/**
 * Returns true when the estimated token count exceeds the allowed maximum.
 * Mirrors the threshold check in claw-rust compact.rs `should_compact`.
 */
export function shouldCompact(
  estimatedTokens: number,
  maxTokens: number,
): boolean {
  return estimatedTokens > maxTokens;
}

/**
 * Strips `<analysis>…</analysis>` blocks, unwraps `<summary>…</summary>`
 * into a "Summary:\n…" heading, and collapses repeated blank lines.
 * Provider-neutral — no Anthropic phrasing.
 */
export function formatCompactSummary(summary: string): string {
  let text = stripTagBlock(summary, "analysis");

  const summaryContent = extractTagBlock(text, "summary");
  if (summaryContent !== null) {
    text = text.replace(
      `<summary>${summaryContent}</summary>`,
      `Summary:\n${summaryContent.trim()}`,
    );
  }

  return collapseBlankLines(text).trim();
}

/**
 * Builds the provider-neutral preamble text that is injected at the start of a
 * compacted session. Embeds the formatted summary and optional continuation hints.
 *
 * @param summary                  Raw summary string (may contain XML-style tags).
 * @param suppressFollowUpQuestions When true, appends a direct-resume instruction.
 * @param recentMessagesPreserved   When true, notes that recent messages follow verbatim.
 */
export function buildCompactionPreamble(
  summary: string,
  suppressFollowUpQuestions = true,
  recentMessagesPreserved = true,
): string {
  const PREAMBLE =
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation.\n\n";
  const RECENT_NOTE = "Recent messages are preserved verbatim.";
  const RESUME_INSTRUCTION =
    "Continue the conversation from where it left off without asking the user any further questions. " +
    "Resume directly — do not acknowledge the summary, do not recap what was happening, " +
    "and do not preface with continuation text.";

  let base = PREAMBLE + formatCompactSummary(summary);

  if (recentMessagesPreserved) {
    base += "\n\n" + RECENT_NOTE;
  }

  if (suppressFollowUpQuestions) {
    base += "\n" + RESUME_INSTRUCTION;
  }

  return base;
}

/**
 * Given the total number of messages in a transcript, returns the count of
 * messages that will be removed when compacting, keeping `preserveHead`
 * messages at the front and `preserveTail` at the end.
 *
 * Pure arithmetic helper — does no filtering or model calls.
 */
export function compactMessageCount(
  total: number,
  preserveHead: number,
  preserveTail: number,
): number {
  const keep = preserveHead + preserveTail;
  return Math.max(0, total - keep);
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — used only by formatCompactSummary)
// ---------------------------------------------------------------------------

function extractTagBlock(content: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const startIdx = content.indexOf(open);
  if (startIdx === -1) return null;
  const innerStart = startIdx + open.length;
  const closeIdx = content.indexOf(close, innerStart);
  if (closeIdx === -1) return null;
  return content.slice(innerStart, closeIdx);
}

function stripTagBlock(content: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const startIdx = content.indexOf(open);
  const closeIdx = content.indexOf(close);
  if (startIdx === -1 || closeIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(closeIdx + close.length);
}

function collapseBlankLines(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let lastBlank = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank && lastBlank) continue;
    result.push(line);
    lastBlank = isBlank;
  }
  return result.join("\n");
}
