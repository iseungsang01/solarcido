import path from "node:path";

import { createApiClient, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ChatMessage, type ReasoningEffort } from "../api/client.js";
import { promptForCommandApproval } from "../approvals/prompt.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { ConversationRuntime, createDefaultSessionStore } from "../runtime/conversation.js";
import { loadSessionForResume } from "../runtime/session.js";
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
  /**
   * Resume a prior session by id, seeding its persisted transcript.
   */
  resume?: string;
  /**
   * Stream model output token-by-token to stdout.
   */
  stream?: boolean;
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

  let resumeMessages: ChatMessage[] | undefined = undefined;
  if (options.resume) {
    const prior = await loadSessionForResume(options.resume);
    resumeMessages = prior.messages;
    if (!options.quiet) {
      console.log(`[assistant] Resuming session ${prior.id} (${resumeMessages?.length ?? 0} messages)`);
    }
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

  const stream = options.stream === true;
  const summary = await runtime.runTurn({
    goal: options.goal,
    cwd,
    reasoningEffort,
    model: selectedModel,
    approvalPolicy,
    sandbox,
    resumeMessages,
    stream,
    onDelta: stream && !options.quiet ? (text) => process.stdout.write(text) : undefined,
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
