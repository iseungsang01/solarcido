import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import type { PermissionEnforcer } from "../runtime/permission-enforcer.js";
import type { PermissionMode } from "../runtime/permissions.js";

export type FinishPayload = {
  summary: string;
  changed_files: string[];
  next_steps: string[];
};

export type ToolExecutionResult = {
  toolName: string;
  content: string;
  finish?: FinishPayload;
};

export type InteractionHandler = {
  /** Free-text prompt. Returns the user's line. */
  askText(prompt: string): Promise<string>;
  /** Yes/No. Returns true on yes. */
  askYesNo(question: string): Promise<boolean>;
  /** Numbered choice from options. Returns the chosen value (or raw text if the user typed something else). */
  askChoice(question: string, options: string[]): Promise<string>;
};

export type PlanModeState = { active: boolean };

export type ToolExecutionContext = {
  root: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  maxPermission?: PermissionMode;
  permissionEnforcer?: PermissionEnforcer;
  /** Optional TTY-backed prompt seam; absent in non-interactive runs. */
  interaction?: InteractionHandler;
  /** Optional conversation-wide plan-mode flag; absent when unsupported. */
  planMode?: PlanModeState;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermission: PermissionMode;
};

export type ToolHandler = (input: unknown, context: ToolExecutionContext) => Promise<ToolExecutionResult>;

export type BuiltinTool = {
  spec: ToolSpec;
  execute: ToolHandler;
};

export type RuntimeToolDefinition = {
  spec: ToolSpec;
  execute?: ToolHandler;
};

export type PluginTool = {
  pluginName: string;
  spec: ToolSpec;
  execute?: ToolHandler;
};
