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

export type ToolExecutionContext = {
  root: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  maxPermission?: PermissionMode;
  permissionEnforcer?: PermissionEnforcer;
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
