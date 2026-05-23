import { createPlan } from "../agents/planner.js";
import { exploreGoal } from "../agents/explorer.js";
import { executePlan } from "../agents/executor.js";
import { verifyExecution } from "../agents/verifier.js";
import { reviewExecution } from "../agents/reviewer.js";
import type { AgentResult, OrchestrationResult } from "../agents/types.js";
import { DEFAULT_REASONING_EFFORT, type ApiClient, type ReasoningEffort } from "../api/client.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";

/**
 * Orchestrate a multi-agent workflow.
 */
export async function orchestrateGoal(
  client: ApiClient,
  goal: string,
  cwd: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
  approvalPolicy: ApprovalPolicy = "on-failure",
  sandbox: SandboxMode = "workspace-write",
): Promise<OrchestrationResult> {
  // 1. Planner
  const plan = await createPlan(client, goal, reasoningEffort, model);
  const plannerResult: AgentResult = {
    role: "planner",
    summary: plan.summary,
    findings: plan.executionSteps,
    changedFiles: [],
    evidence: [],
    risks: [],
    nextSteps: plan.executionSteps,
  };

  // 2. Explorer
  const explorerResult = await exploreGoal(client, goal, plan, cwd, reasoningEffort, model);

  // 3. Executor
  const executorResult = await executePlan(client, goal, plan, cwd, reasoningEffort, model, approvalPolicy, sandbox);
  const executorAgentResult: AgentResult = {
    role: "executor",
    summary: executorResult.finish.summary,
    findings: executorResult.finish.next_steps,
    changedFiles: executorResult.finish.changed_files,
    evidence: executorResult.finish.changed_files.map((file) => `File: ${file}`),
    risks: executorResult.finish.next_steps.map((step) => `Risk: ${step}`),
    nextSteps: executorResult.finish.next_steps,
  };

  // 4. Verifier
  const verifierResult = await verifyExecution(client, goal, plan, executorResult, cwd, reasoningEffort, model);

  // 5. Reviewer
  const reviewerResult = await reviewExecution(client, goal, plan, explorerResult, executorResult, verifierResult, cwd, reasoningEffort, model);
  const reviewerAgentResult: AgentResult = {
    role: "reviewer",
    summary: reviewerResult.summary,
    findings: reviewerResult.concerns,
    changedFiles: [],
    evidence: [],
    risks: reviewerResult.concerns.map((concern) => `Concern: ${concern}`),
    nextSteps: reviewerResult.concerns,
  };

  // Combine into OrchestrationResult
  const orchestrationResult: OrchestrationResult = {
    summary: `Goal "${goal}" completed via multi-agent orchestration.`,
    changedFiles: executorResult.finish?.changed_files ?? [],
    nextSteps: reviewerResult.concerns,
    agentResults: [plannerResult, explorerResult, executorAgentResult, verifierResult, reviewerAgentResult],
  };

  return orchestrationResult;
}
