import path from "node:path";
import type OpenAI from "openai";

import { createPlan } from "./agents/planner.js";
import { exploreGoal } from "./agents/explorer.js";
import { executePlan } from "./agents/executor.js";
import { verifyExecution } from "./agents/verifier.js";
import { reviewExecution } from "./agents/reviewer.js";
import { estimateTranscriptTokens, compactTranscript, shouldCompact } from "./context-budget.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { createToolDefinitions, executeToolCall, type FinishPayload } from "../tools/registry.js";
import { blockedPrematureFinishMessage, goalLikelyRequiresModification, isSuccessfulModificationTool } from "../agents/execution-guard.js";

/**
 * Orchestrate a multi-agent workflow.
 */
export async function orchestrateGoal(
  client: OpenAI,
  goal: string,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
  approvalPolicy?: string,
  sandbox?: string,
): Promise<any> {
  // 1. Planner
  const plan = await createPlan(client, goal, reasoningEffort, model);
  const plannerResult: any = {
    role: "planner",
    summary: plan.summary,
    findings: plan.steps.map((s) => `${s.title}: ${s.goal}`),
    changedFiles: [],
    evidence: [],
    risks: [],
    nextSteps: plan.steps.map((s) => s.goal),
  };

  // 2. Explorer
  const explorerResult = await exploreGoal(client, goal, plan, cwd, reasoningEffort, model);

  // 3. Executor
  const executorResult = await executePlan(client, goal, plan, cwd, reasoningEffort, model);

  // 4. Verifier
  const verifierResult = await verifyExecution(client, goal, plan, executorResult, explorerResult, cwd, reasoningEffort, model);

  // 5. Reviewer
  const reviewerResult = await reviewExecution(client, goal, plan, explorerResult, executorResult, verifierResult, cwd, reasoningEffort, model);

  // Combine into OrchestrationResult
  const orchestrationResult: any = {
    summary: `Goal "${goal}" completed via multi-agent orchestration.`,
    changedFiles: executorResult.finish?.changed_files ?? [],
    nextSteps: reviewerResult.verdict === "approved" ? [] : reviewerResult.concerns,
    agentResults: [plannerResult, explorerResult, executorResult, verifierResult, reviewerResult],
  };

  return orchestrationResult;
}

/**
 * Verify execution results.
 */
export async function verifyExecution(
  client: OpenAI,
  goal: string,
  plan: WorkflowPlan,
  executorResult: ExecutionResult,
  explorerResult: AgentResult,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<VerificationResult> {
  const tools = await import("../tools/registry.js");
  const toolDefinitions = tools.createToolDefinitions();
  const transcript: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are a verifier agent in a Solar-only CLI.",
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
        `Execution summary: ${executorResult.finish?.summary ?? "<none>"}`,
        `Changed files: ${executorResult.finish?.changed_files?.join(", ") ?? "<none>"}`,
        `Suggested next steps: ${executorResult.finish?.next_steps?.join(", ") ?? "<none>"}`,
        `Findings: ${explorerResult.findings?.join(", ") ?? "<none>"}`,
        `Risks: ${explorerResult.risks?.join(", ") ?? "<none>"}`,
        `Evidence: ${explorerResult.evidence?.join(", ") ?? "<none>"}`,
        `Verification commands: ${plan.verificationCommands?.join(", ") ?? "<none>"}`,
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
      throw new Error("Verifier returned no message.");
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
          role: "verifier",
          summary: result.finish.summary,
          findings: result.finish.next_steps,
          changedFiles: result.finish.changed_files,
          evidence: result.finish.changed_files.map((f) => `File: ${f}`),
          risks: result.finish.next_steps.map((s) => `Risk: ${s}`),
          nextSteps: result.finish.next_steps,
        };
      }
    }
  }
}
