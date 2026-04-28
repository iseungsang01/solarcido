import path from "node:path";
import type OpenAI from "openai";

import { createSolarClient, runSolarChat } from "../solar/client.js";
import { DEFAULT_MAX_STEPS, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";

export type RunWorkflowOptions = {
  goal: string;
  cwd?: string;
  maxSteps?: number;
  reasoningEffort?: ReasoningEffort;
  model?: string;
};

export async function runWorkflow(options: RunWorkflowOptions): Promise<void> {
  const client = createSolarClient();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const model = options.model;
  const tools = createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are Solarcido, a direct coding assistant for the current repository.",
        "Work like a coding terminal assistant: inspect files, edit files, run commands, and finish only when the task is done.",
        "Use tools whenever you need repository context or need to make changes.",
        "Stay inside the provided working directory.",
        "Do not create a plan/review split unless the user explicitly asks for it.",
        "When the task is complete, call the finish tool.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Goal: ${options.goal}`,
        `Working directory: ${cwd}`,
      ].join("\n"),
    },
  ];

  console.log(`\n[assistant] Goal: ${options.goal}`);
  console.log(`[assistant] Working in ${cwd}`);

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
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
      throw new Error("Assistant returned no message.");
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls,
    });

    if (message.content) {
      transcript.push(`assistant: ${message.content}`);
      console.log(`[assistant] ${message.content}`);
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      const result = await executeToolCall(cwd, toolCall);
      transcript.push(`tool:${result.toolName}: ${result.content}`);
      console.log(`[tool:${result.toolName}] ${result.content}`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content,
      });

      if (result.finish) {
        printFinish(result.finish);
        return;
      }
    }
  }

  throw new Error(`Assistant hit the max step limit (${maxSteps}) without calling finish.`);
}

function printFinish(finish: FinishPayload): void {
  console.log(`\n[done] ${finish.summary}`);

  if (finish.changed_files.length > 0) {
    console.log(`[done] Changed files: ${finish.changed_files.join(", ")}`);
  }

  if (finish.next_steps.length > 0) {
    console.log("[done] Next steps:");
    for (const step of finish.next_steps) {
      console.log(`  - ${step}`);
    }
  }
}
