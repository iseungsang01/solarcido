/**
 * MCP naming + signature utilities (pure, provider-neutral).
 *
 * Ported from claw-rust crates/runtime/src/mcp.rs. The Anthropic-specific
 * CCR-proxy URL unwrapping is intentionally dropped here — this layer is
 * provider-neutral, so a server's URL signature is simply its URL.
 *
 * `normalizeNameForMcp` maps a free-form server/tool name into the character
 * set the MCP tool namespace allows (`[A-Za-z0-9_-]`), replacing everything
 * else with `_`. Collapsed/trimmed underscores are applied only when the name
 * carries a leading server prefix (kept generic via {@link COLLAPSE_PREFIX}).
 */

/**
 * Server-name prefix that triggers underscore collapsing + trimming during
 * normalization. Kept as a generic marker (the Rust port hard-coded the
 * `claude.ai ` vendor prefix; here it is just "a leading vendor label").
 */
export const COLLAPSE_PREFIX = "claude.ai ";

/** Replace every character outside `[A-Za-z0-9_-]` with `_`. */
function sanitizeChars(name: string): string {
  let out = "";
  for (const ch of name) {
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : "_";
  }
  return out;
}

/** Collapse runs of `_` down to a single `_`. */
function collapseUnderscores(value: string): string {
  let out = "";
  let lastWasUnderscore = false;
  for (const ch of value) {
    if (ch === "_") {
      if (!lastWasUnderscore) out += ch;
      lastWasUnderscore = true;
    } else {
      out += ch;
      lastWasUnderscore = false;
    }
  }
  return out;
}

/** Strip leading/trailing `_`. */
function trimUnderscores(value: string): string {
  return value.replace(/^_+/, "").replace(/_+$/, "");
}

/**
 * Normalize a server or tool name into the MCP-safe character set.
 *
 * Names carrying the {@link COLLAPSE_PREFIX} vendor label additionally have
 * their underscore runs collapsed and edges trimmed, matching how vendor
 * server labels are rendered into tool namespaces.
 */
export function normalizeNameForMcp(name: string): string {
  let normalized = sanitizeChars(name);
  if (name.startsWith(COLLAPSE_PREFIX)) {
    normalized = trimUnderscores(collapseUnderscores(normalized));
  }
  return normalized;
}

/** `mcp__<normalized-server>__` — the namespace prefix for a server's tools. */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__`;
}

/** Fully-qualified MCP tool name: `mcp__<server>__<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${mcpToolPrefix(serverName)}${normalizeNameForMcp(toolName)}`;
}

/**
 * A transport descriptor sufficient to compute a stable signature. Mirrors the
 * provider-neutral subset of the Rust `McpServerConfig` shapes: a stdio command
 * line, or a URL-based remote (sse/http/ws).
 */
export type McpSignatureTarget =
  | { kind: "stdio"; command: string; args?: string[] }
  | { kind: "url"; url: string };

/** Escape `\` and `|` so a command vector renders unambiguously. */
function escapeCommandPart(part: string): string {
  return part.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function renderCommandSignature(command: string[]): string {
  return `[${command.map(escapeCommandPart).join("|")}]`;
}

/**
 * Stable signature used to dedupe equivalent server definitions. Stdio servers
 * are keyed by their command vector; URL servers by their (provider-neutral)
 * URL. Returns `undefined` for targets without a meaningful signature.
 */
export function mcpServerSignature(target: McpSignatureTarget): string | undefined {
  switch (target.kind) {
    case "stdio": {
      const command = [target.command, ...(target.args ?? [])];
      return `stdio:${renderCommandSignature(command)}`;
    }
    case "url":
      return `url:${target.url}`;
    default:
      return undefined;
  }
}

/**
 * FNV-1a 64-bit hash rendered as a 16-char hex string. Deterministic and
 * dependency-free — a direct port of the Rust `stable_hex_hash` so signatures
 * stay comparable across the two ports.
 */
export function stableHexHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
