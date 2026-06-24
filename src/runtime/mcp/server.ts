/**
 * MCP server session over an INJECTED transport.
 *
 * Ported provider-neutral from claw-rust crates/runtime/src/mcp_server.rs
 * (`McpServer` + `McpServerSpec`). Where the client (`./client.ts`) CONSUMES
 * remote MCP servers, this module lets Solarcido SERVE MCP: it answers the
 * JSON-RPC requests an MCP client (e.g. Claude Desktop, or Solarcido's own
 * client) sends — `initialize`, `tools/list`, and `tools/call`.
 *
 * Design mirrors `./client.ts` and `../lsp/client.ts`:
 *   - an injectable {@link McpServerTransport} (a fake one drives hermetic
 *     tests; the real stdio transport lives behind
 *     {@link createStdioServerTransportFactory} and is NOT exercised by tests),
 *   - reuse of `./protocol.ts` for the JSON-RPC envelope types and the
 *     `Content-Length` framing — no framing is re-implemented here.
 *
 * Faithful to mcp_server.rs semantics: notifications (no `id`) receive no
 * reply; parse errors yield -32700, malformed requests -32600, unknown methods
 * -32601, and bad `tools/call` params -32602; a tool call wraps handler output
 * into a single `text` content block with an `isError` flag.
 *
 * INTENTIONALLY NOT PORTED: nothing from mcp_server.rs is dropped. The Rust
 * server has no resources/prompts/sampling support, so neither does this port.
 */

import { spawn } from "node:child_process";

import {
  MCP_SERVER_PROTOCOL_VERSION,
  decodeContentLengthFrame,
  encodeContentLengthFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpTool,
  type McpToolCallParams,
  type McpToolCallResult,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Transport abstraction (injectable)
// ---------------------------------------------------------------------------

/**
 * One inbound message: either a request (has `id` + `method`) or a notification
 * (has `method`, no `id`). Parse failures are surfaced as `raw` so the session
 * can answer with a JSON-RPC parse error, matching the Rust loop.
 */
export type McpInboundMessage =
  | { kind: "message"; value: JsonRpcRequest<unknown> }
  | { kind: "parse-error"; error: string };

/**
 * Bidirectional message transport for one MCP server session. The transport
 * owns framing: it delivers parsed inbound envelopes via {@link onMessage} and
 * accepts already-built JSON-RPC response envelopes via {@link send}.
 */
export type McpServerTransport = {
  /** Send one JSON-RPC response envelope back to the client. */
  send(message: JsonRpcResponse<unknown>): Promise<void>;
  /** Register a handler for every inbound message (or parse error). */
  onMessage(handler: (message: McpInboundMessage) => void): void;
  /** Register a handler invoked once the peer closes the stream (EOF). */
  onClose(handler: () => void): void;
  /** Tear down the transport. Idempotent. */
  close(): void;
};

/** Describes how to construct a stdio server transport. */
export type McpServerTransportDescriptor = { kind: "stdio" };

/** Factory that builds a live server transport from a descriptor. */
export type McpServerTransportFactory = (descriptor: McpServerTransportDescriptor) => McpServerTransport;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Synchronous (or async) handler invoked for every `tools/call`.
 *
 * Resolving with `{ text }` yields a single `text` content block and
 * `isError: false`. Throwing — or resolving with `{ text, isError: true }` —
 * yields a `text` block with `isError: true`, mirroring the
 * `Ok(text)`/`Err(message)` convention in mcp_server.rs.
 */
export type ToolCallHandler = (
  name: string,
  args: unknown,
) => Promise<ToolCallHandlerResult> | ToolCallHandlerResult;

/** Result of a tool call: the text to surface and whether it is an error. */
export type ToolCallHandlerResult = { text: string; isError?: boolean };

/**
 * Configuration for an {@link McpServerSession}.
 *
 * Named `McpServerSpec` after the Rust `McpServerSpec` to avoid colliding with
 * the client-side server config that describes *remote* MCP servers.
 */
export type McpServerSpec = {
  /** Name advertised in `serverInfo` during `initialize`. */
  serverName: string;
  /** Version advertised in `serverInfo` during `initialize`. */
  serverVersion: string;
  /** Tool descriptors returned for `tools/list`. */
  tools: McpTool[];
  /** Handler invoked for `tools/call`. */
  toolHandler: ToolCallHandler;
};

// ---------------------------------------------------------------------------
// JSON-RPC error codes (per JSON-RPC 2.0 + mcp_server.rs)
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * One MCP server session bound to a transport. Answers `initialize`,
 * `tools/list`, and `tools/call`, dropping notifications, and resolves
 * {@link run} when the peer closes the stream.
 */
export class McpServerSession {
  private closed = false;
  private onCloseResolve: (() => void) | undefined;

  constructor(
    private readonly spec: McpServerSpec,
    private readonly transport: McpServerTransport,
  ) {
    this.transport.onMessage((message) => {
      void this.handleInbound(message);
    });
    this.transport.onClose(() => this.handleStreamClose());
  }

  /**
   * Resolve once the peer closes the inbound stream (EOF) or {@link close} is
   * called. The CLI awaits this to keep the process alive while serving.
   */
  run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.onCloseResolve = resolve;
    });
  }

  /** Stop serving and tear down the transport. Idempotent. */
  close(): void {
    this.handleStreamClose();
    this.transport.close();
  }

  private handleStreamClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onCloseResolve?.();
    this.onCloseResolve = undefined;
  }

  private async handleInbound(message: McpInboundMessage): Promise<void> {
    if (message.kind === "parse-error") {
      // Parse error with null id per JSON-RPC 2.0 §4.2.
      await this.reply(errorResponse(null, PARSE_ERROR, `parse error: ${message.error}`));
      return;
    }

    const request = message.value;

    // Requests and notifications share a wire format; the absence of `id`
    // distinguishes notifications, which must never receive a response.
    if (request.id === undefined || request.id === null) {
      // A null id is a valid JSON-RPC id, but MCP notifications omit `id`
      // entirely. Treat an absent id as a notification (no reply); a present
      // null id still routes through dispatch below.
      if (!("id" in request)) return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      await this.reply(errorResponse(request.id ?? null, INVALID_REQUEST, "invalid request"));
      return;
    }

    await this.reply(await this.dispatch(request));
  }

  private async dispatch(request: JsonRpcRequest<unknown>): Promise<JsonRpcResponse<unknown>> {
    const id = request.id;
    switch (request.method) {
      case "initialize":
        return this.handleInitialize(id);
      case "tools/list":
        return this.handleToolsList(id);
      case "tools/call":
        return this.handleToolsCall(id, request.params);
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `method not found: ${request.method}`);
    }
  }

  private handleInitialize(id: JsonRpcId): JsonRpcResponse<McpInitializeResult> {
    const result: McpInitializeResult = {
      protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: this.spec.serverName, version: this.spec.serverVersion },
    };
    return { jsonrpc: "2.0", id, result };
  }

  private handleToolsList(id: JsonRpcId): JsonRpcResponse<McpListToolsResult> {
    const result: McpListToolsResult = { tools: this.spec.tools };
    return { jsonrpc: "2.0", id, result };
  }

  private async handleToolsCall(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse<unknown>> {
    if (params === undefined || params === null) {
      return errorResponse(id, INVALID_PARAMS, "missing params for tools/call");
    }
    if (typeof params !== "object" || Array.isArray(params)) {
      return errorResponse(id, INVALID_PARAMS, "invalid tools/call params: expected an object");
    }
    const call = params as Partial<McpToolCallParams>;
    if (typeof call.name !== "string") {
      return errorResponse(id, INVALID_PARAMS, "invalid tools/call params: missing tool name");
    }

    const args = call.arguments ?? {};
    let outcome: ToolCallHandlerResult;
    try {
      outcome = await this.spec.toolHandler(call.name, args);
    } catch (error) {
      outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
    }

    const result: McpToolCallResult = {
      content: [{ type: "text", text: outcome.text }],
      isError: outcome.isError ?? false,
    };
    return { jsonrpc: "2.0", id, result };
  }

  private async reply(response: JsonRpcResponse<unknown>): Promise<void> {
    if (this.closed) return;
    await this.transport.send(response);
  }
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse<never> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Default stdio transport (NOT exercised by tests)
// ---------------------------------------------------------------------------

/**
 * A real stdio transport that reads Content-Length-framed JSON-RPC requests
 * from a readable stream and writes framed responses to a writable stream
 * (the process's stdin/stdout by default). Lives behind
 * {@link createStdioServerTransportFactory} and is deliberately excluded from
 * the hermetic unit tests.
 */
class StdioServerTransport implements McpServerTransport {
  private buffer = Buffer.alloc(0);
  private messageHandler: ((message: McpInboundMessage) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input.on("data", (chunk: Buffer) => this.onChunk(chunk));
    this.input.on("end", () => this.handleClose());
    this.input.on("close", () => this.handleClose());
  }

  private onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain every complete frame currently buffered.
    for (;;) {
      let decoded;
      try {
        decoded = decodeContentLengthFrame<JsonRpcRequest<unknown>>(this.buffer);
      } catch (error) {
        // A malformed frame is unrecoverable for a streaming reader (we cannot
        // know how many bytes to skip), so surface a parse error and reset.
        this.buffer = Buffer.alloc(0);
        this.messageHandler?.({ kind: "parse-error", error: error instanceof Error ? error.message : String(error) });
        break;
      }
      if (!decoded) break;
      this.buffer = this.buffer.subarray(decoded.bytesConsumed);
      if (this.messageHandler && decoded.message !== undefined) {
        this.messageHandler({ kind: "message", value: decoded.message });
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }

  async send(message: JsonRpcResponse<unknown>): Promise<void> {
    if (this.closed) return;
    const frame = encodeContentLengthFrame(message);
    await new Promise<void>((resolve, reject) => {
      this.output.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(handler: (message: McpInboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Do not destroy process.stdin/stdout — just stop listening.
    this.input.removeAllListeners("data");
  }
}

/**
 * Build the default server transport factory. Frames JSON-RPC over the
 * process's stdin/stdout. Not used by the hermetic tests.
 */
export function createStdioServerTransportFactory(): McpServerTransportFactory {
  return (descriptor) => {
    if (descriptor.kind === "stdio") return new StdioServerTransport();
    throw new Error(`MCP server transport kind \`${(descriptor as { kind: string }).kind}\` is not supported`);
  };
}
