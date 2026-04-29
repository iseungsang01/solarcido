import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";
import type { ExecutionPlan } from "./planner.js";
import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";

export type ExecutionResult = {
  finish: FinishPayload;
  transcript: string[];
};

export async function executePlan(
  client: OpenAI,
  goal: string,
  plan: ExecutionPlan,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<ExecutionResult> {
  const tools = createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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
        "Plan steps:",
        ...plan.steps.map((step, index) => `${index + 1}. ${step.title} - ${step.goal}`),
      ].join("\n"),
    },
  ];

  while (true) {
    const response = await runSolarChat(client, {
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
      const result = await executeToolCall(cwd, toolCall);
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
