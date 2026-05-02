import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";
import type { AgentResult } from "./types.js";
import type { WorkflowPlan } from "../workflow/types.js";
import type { ExecutionResult } from "./executor.js";
import type { VerificationResult } from "./verifier.js";

/**
 * Reviewer Agent.
 * Checks whether the result satisfies the original goal.
 */
export async function reviewExecution(
  client: OpenAI,
  goal: string,
  plan: WorkflowPlan,
  explorerResult: AgentResult,
  executorResult: ExecutionResult,
  verifierResult: VerificationResult,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<ReviewResult> {
  const tools = await import("../tools/registry.js");
  const toolDefinitions = tools.createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are a reviewer agent in a Solar-only CLI.",
        "You must use read-only tools only.",
        "Stay inside the provided working directory.",
        "When the task is complete, call the finish tool.",
        "Do not mention other models or fallback behavior.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        `Plan summary: ${plan.summary}`,
        `Plan steps: ${plan.executionSteps.map((s) => `${s.title} - ${s.goal}`).join(", ") || "<none>"}`,
        `Exploration targets: ${plan.explorationTargets.join(", ") || "<none>"}`,
        `Verification commands: ${plan.verificationCommands.join(", ") || "<none>"}`,
        `Execution summary: ${executorResult.finish?.summary ?? "<none>"}`,
        `Changed files: ${executorResult.finish?.changed_files?.join(", ") ?? "<none>"}`,
        `Suggested next steps: ${executorResult.finish?.next_steps?.join(", ") ?? "<none>"}`,
        `Explorer findings: ${explorerResult.findings.join(", ") || "<none>"}`,
        `Explorer risks: ${explorerResult.risks.join(", ") || "<none>"}`,
        `Explorer evidence: ${explorerResult.evidence.join(", ") || "<none>"}`,
        `Verifier findings: ${verifierResult.findings.join(", ") || "<none>"}`,
        `Verifier risks: ${verifierResult.risks.join(", ") || "<none>"}`,
        `Verifier evidence: ${verifierResult.evidence.join(", ") || "<none>"}`,
        `Transcript: ${transcript.join("\n")}`,
        `Working directory: ${cwd}`,
      ].join("\n"),
    },
  ];

  while (true) {
    const response = await runSolarChat(client, {
      model,
      messages,
      toolDefinitions,
      toolChoice: "auto",
      reasoningEffort,
      temperature: 0.1,
    });
    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("Reviewer returned no message.");
    }
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls,
    });
    if (message.content) {
      transcript.push(`assistant: ${message.content}`);
    }
    if (!message.tool_calls || message.tool_calls.length === 0) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      const result = await tools.executeToolCall(cwd, toolCall);
      transcript.push(`tool:${result.toolName}: ${result.content}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content,
      });
      if (result.finish) {
        return {
          role: "reviewer",
          summary: result.finish.summary,
          concerns: result.finish.next_steps,
        };
      }
    }
  }
}
