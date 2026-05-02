import path from "node:path";
import type OpenAI from "openai";

import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";
import { createSolarClient, runSolarChat } from "../solar/client.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { blockedPrematureFinishMessage, goalLikelyRequiresModification, isSuccessfulModificationTool } from "../agents/execution-guard.js";
import type { AgentResult } from "../agents/types.js";

/**
 * Generic agent loop for a single role.
 * Used by planner, explorer, executor, verifier, reviewer.
 */
export async function runAgentLoop(
  client: OpenAI,
  role: string,
  goal: string,
  plan?: any,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
  approvalPolicy?: string,
  sandbox?: string,
  quiet?: boolean,
): Promise<AgentResult> {
  const tools = createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        `You are a ${role} agent in a Solar-only CLI.`,
        `You must use tools whenever you need repository context or want to change files.`,
        `Stay inside the provided working directory.`,
        `When the task is complete, call the finish tool.`,
        `Do not mention other models or fallback behavior.`,
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        `Working directory: ${cwd}`,
        ...(plan ? [`Plan summary: ${plan.summary}`] : []),
        ...(plan && plan.explorationTargets ? [`Exploration targets: ${plan.explorationTargets.join(", ") || "<none>"}] : []),
        ...(plan && plan.executionSteps ? [`Execution steps: ${plan.executionSteps.join(", ") || "<none>"}] : []),
        ...(plan && plan.verificationCommands ? [`Verification commands: ${plan.verificationCommands.join(", ") || "<none>"}] : []),
      ].join("\n"),
    },
  ];

  // Print assistant messages only if not quiet.
  if (!quiet) {
    console.log(`\n[assistant] Working in ${cwd}`);
    console.log(`[assistant] Role: ${role}`);
  }

  try {
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
        throw new Error("Agent returned no message.");
      }
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
      });
      if (message.content) {
        transcript.push(`assistant: ${message.content}`);
        if (!quiet) {
          console.log(`[assistant] ${message.content}`);
        }
      }
      if (!message.tool_calls || message.tool_calls.length === 0) {
        continue;
      }
      for (const toolCall of message.tool_calls) {
        const result = await executeToolCall(cwd, toolCall, { approvalPolicy, sandbox });
        const finishBlocked = result.finish && goalLikelyRequiresModification(goal) && sandbox !== "read-only" && !result.finish.changed_files?.length;
        const toolContent = finishBlocked ? blockedPrematureFinishMessage() : result.content;
        const finish = finishBlocked ? undefined : result.finish;

        transcript.push(`tool:${result.toolName}: ${toolContent}`);
        console.log(`[tool:${result.toolName}] ${toolContent}`);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolContent,
        });

        if (finish) {
          return {
            role,
            summary: finish.summary,
            findings: finish.next_steps,
            changedFiles: finish.changed_files,
            evidence: finish.changed_files.map((f) => `File: ${f}`),
            risks: finish.next_steps.map((s) => `Risk: ${s}`),
            nextSteps: finish.next_steps,
          };
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    throw error;
  }
}