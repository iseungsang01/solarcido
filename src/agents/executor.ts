import { DEFAULT_REASONING_EFFORT, runApiChat, type ApiClient, type ChatMessage, type ReasoningEffort } from "../api/client.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import type { WorkflowPlan } from "../workflow/types.js";
import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";
import { estimateTranscriptTokens, compactTranscript } from "../workflow/context-budget.js";

export type ExecutionResult = {
  finish: FinishPayload;
  transcript: string[];
};

/**
 * Executor Agent.
 * Makes edits and may run focused commands.
 */
export async function executePlan(
  client: ApiClient,
  goal: string,
  plan: WorkflowPlan,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
  approvalPolicy: ApprovalPolicy = "on-failure",
  sandbox: SandboxMode = "workspace-write",
): Promise<ExecutionResult> {
  const tools = createToolDefinitions({ maxPermission: sandbox });
  const transcript: string[] = [];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the executor agent in a Solar-only CLI.",
        "You must use tools whenever you need repository context or want to change files.",
        "Stay inside the provided working directory.",
        "When the task is complete, call the finish tool.",
        "Do not mention other models or fallback behavior.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        `Working directory: ${cwd}`,
        `Plan summary: ${plan.summary}`,
        `Exploration targets: ${plan.explorationTargets.join(", ") || "<none>"}`,
        `Execution steps: ${plan.executionSteps.join(", ") || "<none>"}`,
        `Verification commands: ${plan.verificationCommands.join(", ") || "<none>"}`,
      ].join("\n"),
    },
  ];

  while (true) {
    // Check token budget before sending request
    const transcriptTokens = estimateTranscriptTokens(transcript);
    if (transcriptTokens > 90 * 131072 / 100) {
      const compacted = compactTranscript(transcript, 90 * 131072 / 100);
      // Replace transcript with compacted version
      transcript.length = 0;
      transcript.push(...compacted);
    }

    const response = await runApiChat(client, {
      model,
      messages,
      tools,
      toolChoice: "auto",
      reasoningEffort,
      temperature: 0.2,
    });
    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("Executor returned no message.");
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
      const result = await executeToolCall(cwd, toolCall, { approvalPolicy, sandbox });
      transcript.push(`tool:${result.toolName}: ${result.content}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content,
      });
      if (result.finish) {
        return {
          finish: result.finish,
          transcript,
        };
      }
    }
  }
}
