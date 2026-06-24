/**
 * `solarcido mcp-serve` — expose Solarcido's builtin tools over MCP.
 *
 * Solarcido normally CONSUMES MCP (see `src/runtime/mcp/client.ts`); this command
 * makes it SERVE MCP instead, so an external MCP client (e.g. Claude Desktop) can
 * call Solarcido's `read_file`/`search_files`/`run_command`/… tools.
 *
 * The wiring is split so it is testable without a real process:
 *   - {@link buildMcpServerSpec} derives an {@link McpServerSpec} from a tool
 *     registry — the tool list comes from `registry.definitions()` and
 *     `tools/call` routes through `registry.execute()`.
 *   - {@link runMcpServeCommand} wires that spec to a real stdio transport.
 */
import { GlobalToolRegistry } from "../tools/registry.js";
import {
  McpServerSession,
  createStdioServerTransportFactory,
  type McpServerSpec,
  type ToolCallHandlerResult,
} from "../runtime/mcp/server.js";
import type { McpTool } from "../runtime/mcp/protocol.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";

const SERVER_NAME = "solarcido";
const SERVER_VERSION = "0.1.0";

export type BuildMcpServerSpecOptions = {
  /** Working directory tool calls are sandboxed to. */
  root: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  /** Tool registry to expose. Defaults to a fresh registry of builtin tools. */
  registry?: GlobalToolRegistry;
};

/**
 * Build an {@link McpServerSpec} from a tool registry. Each registry tool
 * definition becomes an MCP tool descriptor; `tools/call` is routed through the
 * registry's `execute()` and the textual result is wrapped into MCP's content
 * shape. A tool result beginning with `ERROR:` (the registry's recoverable
 * failure convention) is surfaced with `isError: true`.
 */
export function buildMcpServerSpec(options: BuildMcpServerSpecOptions): McpServerSpec {
  const registry = options.registry ?? new GlobalToolRegistry();

  const tools: McpTool[] = registry.definitions().map((definition) => ({
    name: definition.function.name,
    description: definition.function.description,
    inputSchema: definition.function.parameters,
  }));

  return {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    tools,
    toolHandler: async (name, args): Promise<ToolCallHandlerResult> => {
      const result = await registry.execute(name, args, {
        root: options.root,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
      });
      return { text: result.content, isError: result.content.startsWith("ERROR:") };
    },
  };
}

export type RunMcpServeCommandOptions = {
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
};

/** CLI entry: serve Solarcido's builtin tools over MCP on stdin/stdout. */
export async function runMcpServeCommand(options: RunMcpServeCommandOptions): Promise<void> {
  const spec = buildMcpServerSpec({
    root: options.cwd,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
  });
  const transport = createStdioServerTransportFactory()({ kind: "stdio" });
  const session = new McpServerSession(spec, transport);
  await session.run();
}
