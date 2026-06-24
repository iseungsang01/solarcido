import type { ChatMessage } from "../api/client.js";

/**
 * Token estimation utilities.
 * Deterministic approximation until provider token counts are available.
 *
 * Calibrated against the live solar-pro3 tokenizer: plain ASCII measured at
 * ~5 chars/token, so the `/4` divisor stays intentionally conservative (it
 * over-counts ASCII slightly, which makes compaction trigger a little early —
 * the safe direction). CJK (Korean/Japanese/Chinese) is far denser at
 * ~1.7 chars/token, so it is counted separately; the old uniform `/4` rule
 * under-counted Korean by ~2×, which is the dangerous direction near the window.
 */
const ASCII_CHARS_PER_TOKEN = 4;
const CJK_TOKENS_PER_CHAR = 0.6;
const PER_STRING_OVERHEAD = 10;

function isCjk(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3000 && code <= 0x30ff) || // CJK symbols/punctuation, Hiragana, Katakana
    (code >= 0x3130 && code <= 0x318f) || // Hangul Compatibility Jamo
    (code >= 0x3400 && code <= 0x9fff) || // CJK Unified Ideographs (+ Ext A)
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef)    // Halfwidth/Fullwidth forms
  );
}

export function estimateTokens(content: string): number {
  let ascii = 0;
  let cjk = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (isCjk(content.charCodeAt(i))) cjk += 1;
    else ascii += 1;
  }
  return Math.floor(ascii / ASCII_CHARS_PER_TOKEN) + Math.ceil(cjk * CJK_TOKENS_PER_CHAR) + PER_STRING_OVERHEAD;
}

/**
 * Estimate the tokens a single chat message contributes to the request payload.
 * Unlike the transcript-line estimate, this counts what is actually sent to the
 * API: the text content *and* every tool-call name + arguments JSON (e.g. the
 * full new file body of a `write_file` call), plus a small structural envelope.
 * The old transcript-based estimate omitted tool-call arguments entirely, which
 * let large edits slip past the budget and overflow the window unannounced.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let total = 4; // role + message framing
  if (typeof message.content === "string") {
    total += estimateTokens(message.content);
  }
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.function?.name ?? "");
    total += estimateTokens(call.function?.arguments ?? "");
    total += 6; // tool-call envelope (id, type, function wrapper)
  }
  if (message.tool_call_id) {
    total += 4;
  }
  return total;
}

/** Estimate tokens for a whole message array (the real request payload). */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

export function estimateTranscriptTokens(transcript: string[]): number {
  let total = 0;
  for (const line of transcript) {
    total += estimateTokens(line);
  }
  return total;
}

export function compactTranscript(
  transcript: string[],
  maxTokens: number,
): string[] {
  // Keep only the most recent messages until token budget is met.
  // This is a simple safety valve; real compaction should preserve required facts.
  const compacted: string[] = [];
  let currentTokens = 0;
  for (const line of transcript) {
    const tokens = estimateTokens(line);
    if (currentTokens + tokens > maxTokens) {
      // Skip this line
      continue;
    }
    compacted.push(line);
    currentTokens += tokens;
  }
  return compacted;
}

export function shouldCompact(transcript: string[], maxTokens: number): boolean {
  return estimateTranscriptTokens(transcript) > maxTokens * 0.9;
}

export function getCompactTranscript(
  transcript: string[],
  maxTokens: number,
): string[] {
  if (!shouldCompact(transcript, maxTokens)) {
    return transcript;
  }
  return compactTranscript(transcript, maxTokens);
}

type SummarizableAgentResult = {
  role: string;
  summary?: string;
  findings?: string[];
  changedFiles?: string[];
  evidence?: string[];
  risks?: string[];
  nextSteps?: string[];
};

type SummarizableOrchestrationResult = {
  summary?: string;
  changedFiles?: string[];
  nextSteps?: string[];
  agentResults?: SummarizableAgentResult[];
};

export function formatAgentResultSummary(agentResult: SummarizableAgentResult): string {
  // Helper to produce a concise summary from agentResult fields.
  const parts: string[] = [];
  if (agentResult.summary) parts.push(agentResult.summary);
  if (agentResult.findings?.length) parts.push(`Findings: ${agentResult.findings.join(", ")}.`);
  if (agentResult.evidence?.length) parts.push(`Evidence: ${agentResult.evidence.join(", ")}.`);
  if (agentResult.risks?.length) parts.push(`Risks: ${agentResult.risks.join(", ")}.`);
  if (agentResult.nextSteps?.length) parts.push(`Next steps: ${agentResult.nextSteps.join(", ")}.`);
  if (agentResult.changedFiles?.length) parts.push(`Changed files: ${agentResult.changedFiles.join(", ")}.`);
  return parts.join(" ");
}

export function formatOrchestrationResultSummary(orchestrationResult: SummarizableOrchestrationResult): string {
  const parts: string[] = [];
  if (orchestrationResult.summary) parts.push(orchestrationResult.summary);
  if (orchestrationResult.changedFiles?.length) parts.push(`Changed files: ${orchestrationResult.changedFiles.join(", ")}.`);
  if (orchestrationResult.nextSteps?.length) parts.push(`Next steps: ${orchestrationResult.nextSteps.join(", ")}.`);
  if (orchestrationResult.agentResults?.length) {
    const agentSummaries = orchestrationResult.agentResults.map((result) => `${result.role}: ${formatAgentResultSummary(result)}`);
    parts.push(`Agent results: ${agentSummaries.join(", ")}.`);
  }
  return parts.join(" ");
}
