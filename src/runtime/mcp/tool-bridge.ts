/**
 * MCP tool/resource bridge types + pure mappers (provider-neutral).
 *
 * Ported from claw-rust crates/runtime/src/mcp_tool_bridge.rs. The Rust version
 * carried a stateful, mutex-guarded registry that drove a live
 * `McpServerManager`; here we keep only the *pure data shapes* and the
 * *mapping functions* that turn raw MCP `tools/list` definitions into a generic
 * tool-spec the live tool registry can consume later. Wiring into the registry
 * is intentionally out of scope for this module.
 */

import type { McpResource, McpTool } from "./protocol.js";
import { mcpToolName } from "./naming.js";

/** Connection status of a managed MCP server. */
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "auth_required" | "error";

/** Metadata about a tool exposed by an MCP server. */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Metadata about a resource exposed by an MCP server. */
export type McpResourceInfo = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

/**
 * Generic tool-spec shape consumable by a tool registry. The `qualifiedName`
 * is namespaced via {@link mcpToolName} so it cannot collide with built-in
 * tools; `serverName`/`rawName` retain the routing info needed to dispatch the
 * call back to the originating server.
 */
export type BridgedToolSpec = {
  /** Fully-qualified, namespace-safe tool name: `mcp__<server>__<tool>`. */
  qualifiedName: string;
  /** Originating server name (un-normalized). */
  serverName: string;
  /** Raw tool name as advertised by the server (used for `tools/call`). */
  rawName: string;
  description?: string;
  /** JSON Schema for the tool's arguments, when advertised. */
  inputSchema?: unknown;
};

/** Map a raw MCP tool definition to the lightweight {@link McpToolInfo}. */
export function toToolInfo(tool: McpTool): McpToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Map a raw MCP resource definition to {@link McpResourceInfo}. */
export function toResourceInfo(resource: McpResource): McpResourceInfo {
  return {
    uri: resource.uri,
    name: resource.name ?? resource.uri,
    description: resource.description,
    mimeType: resource.mimeType,
  };
}

/**
 * Map a single raw MCP tool to a generic, namespace-qualified tool-spec for a
 * given server. Pure.
 */
export function bridgeTool(serverName: string, tool: McpTool): BridgedToolSpec {
  return {
    qualifiedName: mcpToolName(serverName, tool.name),
    serverName,
    rawName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Map a server's full `tools/list` payload to generic tool-specs. Pure. */
export function bridgeTools(serverName: string, tools: McpTool[]): BridgedToolSpec[] {
  return tools.map((tool) => bridgeTool(serverName, tool));
}
