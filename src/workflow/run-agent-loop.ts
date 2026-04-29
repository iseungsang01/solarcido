import path from "node:path";
import type OpenAI from "openai";

import type { ApprovalPolicy, SandboxMode } from "../config/schema.js";
import { completeSession, createSession, failSession } from "../sessions/session-store.js";
import { createSolarClient, runSolarChat } from "../solar/client.js";
import { DEFAULT_MAX_STEPS, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";

/**
 * Run workflow options.
 */
export type RunWorkflowOptions = {
  goal: string;
  cwd?: string;
  maxSteps?: number;
  reasoningEffort?: ReasoningEffort;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  /**
   * When true, suppress assistant messages (only tool output).
   */
  quiet?: boolean;
};

/**
 * Run the workflow.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<void> {
  const client = createSolarClient();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const model = options.model;
  const approvalPolicy = options.approvalPolicy ?? "on-failure";
  const sandbox = options.sandbox ?? "workspace-write";
  const session = await createSession({
    goal: options.goal,
    cwd,
    model,
    reasoningEffort,
    approvalPolicy,
    sandbox,
  });
  const tools = createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are Solarcido, a direct coding assistant for the current repository.",
        "Work like a coding terminal assistant: inspect files, edit files, run commands, and finish only when the task is done.",
        "Use tools whenever you need repository context or need to make changes.",
        "Prefer search_files for locating code, read_file with offset/limit for focused inspection, and edit_file for small precise changes.",
        "Use write_file only when creating a new file or replacing a whole file is clearly safer.",
        "After edits, run the most relevant verification command when one exists.",
        "Command failures are returned as tool output; inspect exit_code, stdout, and stderr before deciding the next step.",
        "Stay inside the provided working directory.",
        `Current sandbox mode: ${sandbox}. Current approval policy: ${approvalPolicy}.`,
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

  // Print assistant messages only if not quiet.
  if (!options.quiet) {
    console.log(`\n[assistant] Working in ${cwd}`);
    console.log(`[assistant] Session ${session.id}`);
  }

  try {
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
        if (!options.quiet) {
          console.log(`[assistant] ${message.content}`);
        }
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        continue;
      }

      for (const toolCall of message.tool_calls) {
        const result = await executeToolCall(cwd, toolCall, { approvalPolicy, sandbox });
        transcript.push(`tool:${result.toolName}: ${result.content}`);
        console.log(`[tool:${result.toolName}] ${summarizeToolOutput(result.content)}`);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.content,
        });

        if (result.finish) {
          await completeSession(session, {
            summary: result.finish.summary,
            changedFiles: result.finish.changed_files,
            nextSteps: result.finish.next_steps,
          });
          printFinish(result.finish);
          return;
        }
      }
    }

    throw new Error(`Assistant hit the max step limit (${maxSteps}) without calling finish.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSession(session, message);
    throw error;
  }
}

/**
 * Reduce a tool result to a single line for the on-screen log. The full
 * content still goes into the model's transcript.
 */
function summarizeToolOutput(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  if (!trimmed) return "(empty)";
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
  const lines = trimmed.split(/\r?\n/);
  if (lines.length === 1) return cap(lines[0], 200);
  return `${cap(lines[0], 160)}  [+${lines.length - 1} more lines]`;
}

/**
 * Print finish payload.
 */
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
