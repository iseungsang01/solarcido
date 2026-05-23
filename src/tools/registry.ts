import type { ChatTool, ChatToolCall } from "../api/client.js";
import { promptForCommandApproval } from "../approvals/prompt.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { PermissionEnforcer } from "../runtime/permission-enforcer.js";
import { permissionAllows, type PermissionMode } from "../runtime/permissions.js";
import { BUILTIN_TOOLS } from "./executor.js";
import type {
  BuiltinTool,
  PluginTool,
  RuntimeToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  ToolSpec,
} from "./specs.js";

export type { FinishPayload, ToolExecutionContext, ToolExecutionResult } from "./specs.js";
export { BUILTIN_TOOL_SPECS } from "./executor.js";

export type ToolExecutionOptions = {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  maxPermission?: PermissionMode;
};

const DEFAULT_TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
};

export type ToolDefinitionOptions = {
  allowedTools?: Set<string>;
  maxPermission?: PermissionMode;
};

type RegisteredTool = {
  spec: ToolSpec;
  execute?: ToolHandler;
};

export class GlobalToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(options: {
    builtinTools?: BuiltinTool[];
    runtimeTools?: RuntimeToolDefinition[];
    pluginTools?: PluginTool[];
  } = {}) {
    for (const tool of options.builtinTools ?? BUILTIN_TOOLS) {
      this.registerTool(tool.spec, tool.execute);
    }

    for (const tool of options.runtimeTools ?? []) {
      this.registerTool(tool.spec, tool.execute);
    }

    for (const tool of options.pluginTools ?? []) {
      this.registerTool(tool.spec, tool.execute);
    }
  }

  definitions(options: ToolDefinitionOptions = {}): ChatTool[] {
    const maxPermission = options.maxPermission ?? "danger-full-access";
    const allowedTools = normalizeAllowedTools(options.allowedTools);

    return [...this.tools.values()]
      .filter((tool) => !allowedTools || allowedTools.has(normalizeToolName(tool.spec.name)))
      .filter((tool) => permissionAllows(maxPermission, tool.spec.requiredPermission))
      .map((tool) => toolSpecToChatTool(tool.spec));
  }

  permissionSpecs(options: { allowedTools?: Set<string> } = {}): Array<[string, PermissionMode]> {
    const allowedTools = normalizeAllowedTools(options.allowedTools);

    return [...this.tools.values()]
      .filter((tool) => !allowedTools || allowedTools.has(normalizeToolName(tool.spec.name)))
      .map((tool) => [tool.spec.name, tool.spec.requiredPermission]);
  }

  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const normalizedName = normalizeToolName(name);
    const registeredTool = this.tools.get(normalizedName);

    if (!registeredTool) {
      return { toolName: normalizedName, content: `ERROR: unsupported tool: ${name}` };
    }

    const permissionEnforcer = getPermissionEnforcer(context);
    const permissionDecision = permissionEnforcer.decideTool(registeredTool.spec.requiredPermission, normalizedName);
    if (!permissionDecision.approved) {
      return { toolName: normalizedName, content: `ERROR: ${permissionDecision.reason}` };
    }

    if (!registeredTool.execute) {
      return { toolName: normalizedName, content: `ERROR: ${normalizedName} is registered without an executor.` };
    }

    try {
      const result = await registeredTool.execute(input, { ...context, permissionEnforcer });
      return result.toolName === normalizedName ? result : { ...result, toolName: normalizedName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { toolName: normalizedName, content: `ERROR: ${message}` };
    }
  }

  private registerTool(spec: ToolSpec, execute?: ToolHandler): void {
    const normalizedName = normalizeToolName(spec.name);
    this.tools.set(normalizedName, {
      spec: { ...spec, name: normalizedName },
      execute,
    });
  }
}

const DEFAULT_TOOL_REGISTRY = new GlobalToolRegistry();

export function createToolDefinitions(options: ToolDefinitionOptions = {}): ChatTool[] {
  return DEFAULT_TOOL_REGISTRY.definitions(options);
}

export async function executeToolCall(
  root: string,
  toolCall: ChatToolCall,
  options: ToolExecutionOptions = DEFAULT_TOOL_EXECUTION_OPTIONS,
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name;
  let args: unknown;

  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { toolName: normalizeToolName(name), content: `ERROR: invalid JSON arguments: ${message}` };
  }

  return DEFAULT_TOOL_REGISTRY.execute(name, args, {
    root,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    maxPermission: options.maxPermission,
  });
}

export function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replaceAll("-", "_");

  switch (normalized) {
    case "bash":
      return "run_command";
    case "glob_search":
      return "list_files";
    case "grep_search":
      return "search_files";
    default:
      return normalized;
  }
}

function normalizeAllowedTools(allowedTools?: Set<string>): Set<string> | undefined {
  return allowedTools ? new Set([...allowedTools].map(normalizeToolName)) : undefined;
}

function toolSpecToChatTool(spec: ToolSpec): ChatTool {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  };
}

function getPermissionEnforcer(context: ToolExecutionContext): PermissionEnforcer {
  return context.permissionEnforcer ?? new PermissionEnforcer({
    approvalPolicy: context.approvalPolicy,
    sandbox: context.sandbox,
    maxPermission: context.maxPermission,
    approveCommand: promptForCommandApproval,
  });
}
