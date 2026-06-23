import path from "node:path";

import { createApiClientForModel, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ChatMessage, type ReasoningEffort } from "../api/client.js";
import { promptForCommandApproval } from "../approvals/prompt.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { ConversationRuntime, createDefaultSessionStore, type TurnSummary } from "../runtime/conversation.js";
import { loadSessionForResume } from "../runtime/session.js";
import { buildMcpManager, loadMcpServers } from "../runtime/mcp/config.js";
import { mcpToolsAsRuntimeTools } from "../tools/mcp-tools.js";
import type { RuntimeToolDefinition } from "../tools/specs.js";
import { HookRunner } from "../runtime/hooks.js";
import { loadHookConfig } from "../runtime/hooks-config.js";
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
export async function runWorkflow(options: RunWorkflowOptions): Promise<TurnSummary> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const selectedModel = options.model ?? DEFAULT_MODEL;
  const client = createApiClientForModel(selectedModel);
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

  const mcpServers = loadMcpServers();
  let mcpManager: ReturnType<typeof buildMcpManager> | undefined;
  let runtimeTools: RuntimeToolDefinition[] = [];
  if (Object.keys(mcpServers).length > 0) {
    try {
      mcpManager = buildMcpManager(mcpServers);
      const { tools, failedServers } = await mcpManager.discoverToolsBestEffort();
      runtimeTools = mcpToolsAsRuntimeTools(tools, (name, args) => mcpManager!.invoke(name, args));
      if (!options.quiet) {
        const failed = failedServers.length > 0 ? `, ${failedServers.length} server(s) failed` : "";
        console.log(`[assistant] MCP: ${tools.length} tool(s) from ${Object.keys(mcpServers).length} server(s)${failed}`);
      }
    } catch (error) {
      // MCP must never break a run.
      mcpManager?.shutdown();
      mcpManager = undefined;
      if (!options.quiet) {
        console.log(`[assistant] MCP disabled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const hookConfig = loadHookConfig();
  const hookCount = hookConfig.preToolUse.length + hookConfig.postToolUse.length + hookConfig.postToolUseFailure.length;
  if (hookCount > 0 && !options.quiet) {
    console.log(`[assistant] Hooks: ${hookCount} configured`);
  }

  const runtime = new ConversationRuntime({
    apiClient: client,
    toolRegistry: new GlobalToolRegistry({ runtimeTools }),
    sessionStore: createDefaultSessionStore(),
    permissionEnforcer: new PermissionEnforcer({
      approvalPolicy,
      sandbox,
      approveCommand: promptForCommandApproval,
    }),
    promptBuilder: new SystemPromptBuilder(),
    hookRunner: new HookRunner(hookConfig),
  });

  const stream = options.stream === true;
  try {
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
    return summary;
  } finally {
    mcpManager?.shutdown();
  }
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
