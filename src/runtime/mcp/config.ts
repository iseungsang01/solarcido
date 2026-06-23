/**
 * MCP server configuration loaded from `$SOLARCIDO_HOME/mcp.json` (kept separate
 * from the scalar config.json so it can hold nested server definitions). Absent
 * or malformed config yields no servers — MCP is strictly opt-in and additive.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { getSolarcidoHome } from "../config.js";
import { McpServerManager, createStdioTransportFactory, type McpTransportFactory } from "./client.js";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export function getMcpConfigPath(): string {
  return path.join(getSolarcidoHome(), "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an mcp.json document into a server map. Accepts `{mcpServers:{…}}` or a flat map. */
export function parseMcpServers(raw: string): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const root = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!isRecord(root)) return {};

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(root)) {
    if (!isRecord(value) || typeof value.command !== "string") continue;
    const args = Array.isArray(value.args)
      ? value.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = isRecord(value.env)
      ? (Object.fromEntries(
          Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ) as Record<string, string>)
      : undefined;
    servers[name] = { command: value.command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }
  return servers;
}

/** Load configured MCP servers, returning `{}` when the file is absent/invalid. */
export function loadMcpServers(configPath: string = getMcpConfigPath()): Record<string, McpServerConfig> {
  try {
    return parseMcpServers(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

/** Build a manager wiring each configured server to a (default stdio) transport. */
export function buildMcpManager(
  servers: Record<string, McpServerConfig>,
  factory: McpTransportFactory = createStdioTransportFactory(),
): McpServerManager {
  const manager = new McpServerManager();
  for (const [serverName, config] of Object.entries(servers)) {
    const transport = factory({ kind: "stdio", command: config.command, args: config.args, env: config.env });
    manager.registerServer({ serverName, transport });
  }
  return manager;
}
