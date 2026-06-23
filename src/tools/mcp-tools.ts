/**
 * Adapt discovered MCP tools into runtime tool definitions the GlobalToolRegistry
 * can register and dispatch, so the model can invoke MCP tools like built-ins.
 * Pure: the actual invocation is delegated to an injected `invoke` function
 * (normally `manager.invoke`), keeping this testable without a live server.
 */
import type { BridgedToolSpec } from "../runtime/mcp/tool-bridge.js";
import type { RuntimeToolDefinition, ToolExecutionResult, ToolSpec } from "./specs.js";

/** A minimal view of an MCP `tools/call` result for rendering. */
export type McpCallResultLike = {
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
};

/** Render an MCP tools/call result into concise, model-readable text. */
export function formatMcpToolResult(result: McpCallResultLike): string {
  const parts = (result.content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
    .filter((text) => text.length > 0);
  const body = parts.length > 0 ? parts.join("\n") : "(no content)";
  return result.isError ? `ERROR: ${body}` : body;
}

function toInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

/**
 * Convert bridged MCP tool specs into runtime tool definitions. Each tool's
 * executor routes the call back through `invoke(qualifiedName, args)` and
 * surfaces failures as `ERROR: ...` tool output (the loop continues on errors).
 */
export function mcpToolsAsRuntimeTools(
  specs: BridgedToolSpec[],
  invoke: (qualifiedName: string, args: unknown) => Promise<McpCallResultLike>,
): RuntimeToolDefinition[] {
  return specs.map((spec): RuntimeToolDefinition => {
    const toolSpec: ToolSpec = {
      name: spec.qualifiedName,
      description: spec.description ?? `MCP tool \`${spec.rawName}\` from server \`${spec.serverName}\``,
      inputSchema: toInputSchema(spec.inputSchema),
      requiredPermission: "workspace-write",
    };
    return {
      spec: toolSpec,
      execute: async (input): Promise<ToolExecutionResult> => {
        try {
          const result = await invoke(spec.qualifiedName, input);
          return { toolName: spec.qualifiedName, content: formatMcpToolResult(result) };
        } catch (error) {
          return {
            toolName: spec.qualifiedName,
            content: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  });
}
