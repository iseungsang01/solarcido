import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";
import type { AgentResult } from "./types.js";
import type { WorkflowPlan } from "../workflow/types.js";

/**
 * Explorer Agent.
 * Investigates the repository using read-only tools.
 */
export async function exploreGoal(
  client: OpenAI,
  goal: string,
  plan: WorkflowPlan,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<AgentResult> {
  const tools = await import("../tools/registry.js");
  const toolDefinitions = tools.createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are an explorer agent in a Solar-only CLI.",
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
        `Plan steps: ${plan.executionSteps.join(", ") || "<none>"}`,
        `Exploration targets: ${plan.explorationTargets.join(", ") || "<none>"}`,
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
      temperature: 0.2,
    });
    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("Explorer returned no message.");
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
          role: "explorer",
          summary: result.finish.summary,
          findings: result.finish.next_steps, // use next steps as findings
          changedFiles: [],
          evidence: result.finish.changed_files.map((f) => `File: ${f}`),
          risks: [],
          nextSteps: result.finish.next_steps,
        };
      }
    }
  }
}
