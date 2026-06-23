import path from "node:path";

import { createApiClient, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../api/client.js";
import { promptForCommandApproval } from "../approvals/prompt.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { ConversationRuntime, createDefaultSessionStore } from "../runtime/conversation.js";
import { PermissionEnforcer } from "../runtime/permission-enforcer.js";
import { SystemPromptBuilder } from "../runtime/prompt.js";
import { GlobalToolRegistry, type FinishPayload } from "../tools/registry.js";
import { estimateCostUsd, formatUsd, pricingForModel, type TokenUsage } from "../runtime/usage.js";

/**
 * Run workflow options.
 */
export type RunWorkflowOptions = {
  goal: string;
  cwd?: string;
  reasoningEffort?: ReasoningEffort;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  /**
   * When true, suppress assistant status messages.
   */
  quiet?: boolean;
};

/**
 * Run the workflow.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<void> {
  const client = createApiClient();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const selectedModel = options.model ?? DEFAULT_MODEL;
  const approvalPolicy = options.approvalPolicy ?? "on-failure";
  const sandbox = options.sandbox ?? "workspace-write";

  if (!options.quiet) {
    console.log(`\n[assistant] Working in ${cwd}`);
  }

  const runtime = new ConversationRuntime({
    apiClient: client,
    toolRegistry: new GlobalToolRegistry(),
    sessionStore: createDefaultSessionStore(),
    permissionEnforcer: new PermissionEnforcer({
      approvalPolicy,
      sandbox,
      approveCommand: promptForCommandApproval,
    }),
    promptBuilder: new SystemPromptBuilder(),
  });

  const summary = await runtime.runTurn({
    goal: options.goal,
    cwd,
    reasoningEffort,
    model: selectedModel,
    approvalPolicy,
    sandbox,
  });

  if (!options.quiet) {
    console.log(`[assistant] Session ${summary.session.id}`);
    printUsage(summary.usage, selectedModel);
  }
  printFinish(summary.finish);
}

/**
 * Print token usage and (best-effort) cost for the run.
 */
function printUsage(usage: TokenUsage, model: string): void {
  if (usage.totalTokens <= 0) return;

  const pricing = pricingForModel(model);
  const cost = pricing ? ` (${formatUsd(estimateCostUsd(usage, pricing))})` : "";
  console.log(
    `[assistant] Tokens: ${usage.inputTokens} in + ${usage.outputTokens} out = ${usage.totalTokens}${cost}`,
  );
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
