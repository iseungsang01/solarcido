/**
 * MCP JSON-RPC protocol types + line/Content-Length framing (pure).
 *
 * Ported provider-neutral from claw-rust crates/runtime/src/mcp_stdio.rs and
 * mcp_server.rs. This module owns:
 *   - the JSON-RPC 2.0 request/response/error shapes,
 *   - the MCP method payload types (initialize / tools/list / tools/call /
 *     resources/list / resources/read),
 *   - `Content-Length`-framed encode/decode used over stdio,
 *   - a line-delimited (newline) encode/decode variant.
 *
 * Everything here is synchronous and side-effect free so it can be unit-tested
 * without any transport.
 */

/** Protocol version advertised by both the built-in client and server. */
export const MCP_SERVER_PROTOCOL_VERSION = "2025-03-26";

/** Default `initialize` clientInfo when none is supplied. */
export const DEFAULT_CLIENT_INFO: McpInitializeClientInfo = {
  name: "solarcido",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

/** JSON-RPC id: number, string, or null (untagged on the wire). */
export type JsonRpcId = number | string | null;

export type JsonRpcRequest<T = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: T;
};

export type JsonRpcNotification<T = unknown> = {
  jsonrpc: "2.0";
  method: string;
  params?: T;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
};

/** Build a JSON-RPC request envelope. */
export function makeRequest<T>(id: JsonRpcId, method: string, params?: T): JsonRpcRequest<T> {
  const request: JsonRpcRequest<T> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) request.params = params;
  return request;
}

// ---------------------------------------------------------------------------
// MCP method payloads
// ---------------------------------------------------------------------------

export type McpInitializeClientInfo = { name: string; version: string };
export type McpInitializeServerInfo = { name: string; version: string };

export type McpInitializeParams = {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: McpInitializeClientInfo;
};

export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpInitializeServerInfo;
};

export type McpListToolsParams = { cursor?: string };

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
};

export type McpListToolsResult = {
  tools: McpTool[];
  nextCursor?: string;
};

export type McpToolCallParams = {
  name: string;
  arguments?: unknown;
  _meta?: unknown;
};

export type McpToolCallContent = {
  type: string;
  [key: string]: unknown;
};

export type McpToolCallResult = {
  content: McpToolCallContent[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
};

export type McpListResourcesParams = { cursor?: string };

export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  annotations?: unknown;
  _meta?: unknown;
};

export type McpListResourcesResult = {
  resources: McpResource[];
  nextCursor?: string;
};

export type McpReadResourceParams = { uri: string };

export type McpResourceContents = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: unknown;
};

export type McpReadResourceResult = {
  contents: McpResourceContents[];
};

/** Build the default `initialize` params with optional clientInfo override. */
export function defaultInitializeParams(clientInfo: McpInitializeClientInfo = DEFAULT_CLIENT_INFO): McpInitializeParams {
  return {
    protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo,
  };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Raised when a frame's headers/body cannot be parsed. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/**
 * Encode a JSON-RPC message as an LSP-style `Content-Length`-framed buffer:
 * `Content-Length: N\r\n\r\n<utf8 json body>`.
 */
export function encodeContentLengthFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

/**
 * Decoded frame plus the number of bytes consumed from the input buffer, so a
 * caller can advance a streaming read position.
 */
export type DecodedFrame<T = unknown> = { message: T; bytesConsumed: number };

/**
 * Decode a single `Content-Length`-framed message from the front of `buffer`.
 *
 * Returns `undefined` when the buffer does not yet contain a complete frame
 * (header terminator or full body not present) so a streaming reader can wait
 * for more bytes. Throws {@link FramingError} on a malformed/absent
 * `Content-Length` header.
 *
 * Header matching is case-insensitive, matching the Rust transport.
 */
export function decodeContentLengthFrame<T = unknown>(buffer: Buffer): DecodedFrame<T> | undefined {
  const separator = buffer.indexOf("\r\n\r\n");
  if (separator === -1) return undefined;

  const headerText = buffer.subarray(0, separator).toString("utf8");
  let contentLength: number | undefined;
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (name.toLowerCase() === "content-length") {
      const parsed = Number.parseInt(line.slice(colon + 1).trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new FramingError(`invalid Content-Length header: ${line}`);
      }
      contentLength = parsed;
    }
  }

  if (contentLength === undefined) {
    throw new FramingError("missing Content-Length header");
  }

  const bodyStart = separator + 4;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return undefined;

  const bodyText = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  let message: T;
  try {
    message = JSON.parse(bodyText) as T;
  } catch (error) {
    throw new FramingError(`invalid JSON body: ${(error as Error).message}`);
  }
  return { message, bytesConsumed: bodyEnd };
}

/**
 * Encode a JSON-RPC message as a single newline-delimited line
 * (`<utf8 json>\n`). Some MCP servers speak line-delimited JSON-RPC instead of
 * Content-Length framing.
 */
export function encodeLineFrame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

/**
 * Decode a single newline-delimited message from the front of `buffer`.
 *
 * Returns `undefined` when no complete line is present yet. Throws
 * {@link FramingError} when the completed line is not valid JSON.
 */
export function decodeLineFrame<T = unknown>(buffer: Buffer): DecodedFrame<T> | undefined {
  const newline = buffer.indexOf("\n");
  if (newline === -1) return undefined;

  const lineText = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  // Skip blank keep-alive lines by consuming them with no message.
  if (lineText.trim() === "") {
    return { message: undefined as unknown as T, bytesConsumed: newline + 1 };
  }
  let message: T;
  try {
    message = JSON.parse(lineText) as T;
  } catch (error) {
    throw new FramingError(`invalid JSON line: ${(error as Error).message}`);
  }
  return { message, bytesConsumed: newline + 1 };
}

/**
 * The two framings supported by the stdio transport. `content-length` is the
 * default used by the built-in server.
 */
export type FramingMode = "content-length" | "line";

/** Encode a message under the chosen framing mode. */
export function encodeFrame(message: unknown, mode: FramingMode = "content-length"): Buffer {
  return mode === "line" ? encodeLineFrame(message) : encodeContentLengthFrame(message);
}

/** Decode the next frame from `buffer` under the chosen framing mode. */
export function decodeFrame<T = unknown>(
  buffer: Buffer,
  mode: FramingMode = "content-length",
): DecodedFrame<T> | undefined {
  return mode === "line" ? decodeLineFrame<T>(buffer) : decodeContentLengthFrame<T>(buffer);
}
