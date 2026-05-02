import type OpenAI from "openai";

/**
 * Token estimation utilities for multi-agent orchestration.
 * This is a deterministic approximation until provider token counts are available.
 */
export function estimateTokens(content: string): number {
  // One token per four characters, plus a fixed overhead per message.
  // This is a conservative first implementation.
  const charCount = content.length;
  // Overhead per message (including role, content, etc.)
  const overhead = 10;
  return Math.floor(charCount / 4) + overhead;
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

export function formatAgentResultSummary(agentResult: any): string {
  // Helper to produce a concise summary from agentResult fields.
  const parts: string[] = [];
  if (agentResult.summary) parts.push(agentResult.summary);
  if (agentResult.findings.length) parts.push(`Findings: ${agentResult.findings.join(", ")}.`);
  if (agentResult.evidence.length) parts.push(`Evidence: ${agentResult.evidence.join(", ")}.`);
  if (agentResult.risks.length) parts.push(`Risks: ${agentResult.risks.join(", ")}.`);
  if (agentResult.nextSteps.length) parts.push(`Next steps: ${agentResult.nextSteps.join(", ")}.`);
  if (agentResult.changedFiles.length) parts.push(`Changed files: ${agentResult.changedFiles.join(", ")}.`);
  return parts.join(" ");
}

export function formatOrchestrationResultSummary(orchestrationResult: any): string {
  const parts: string[] = [];
  if (orchestrationResult.summary) parts.push(orchestrationResult.summary);
  if (orchestrationResult.changedFiles.length) parts.push(`Changed files: ${orchestrationResult.changedFiles.join(", ")}.`);
  if (orchestrationResult.nextSteps.length) parts.push(`Next steps: ${orchestrationResult.nextSteps.join(", ")}.`);
  if (orchestrationResult.agentResults.length) {
    const agentSummaries = orchestrationResult.agentResults.map((r) => r.role + ": " + formatAgentResultSummary(r));
    parts.push(`Agent results: ${agentSummaries.join(", ")}.`);
  }
  return parts.join(" ");
}
