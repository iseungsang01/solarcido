/**
 * MCP client session manager over an INJECTED transport.
 *
 * Ported provider-neutral from claw-rust crates/runtime/src/mcp_stdio.rs
 * (`McpServerManager`) + mcp_client.rs (transport abstraction). The Anthropic
 * OAuth / managed-proxy specifics are dropped; the transport *shape* is kept so
 * stdio/sse/http/ws can all be described, while only stdio/mock are driven.
 *
 * The manager performs `initialize` -> `tools/list` discovery, then exposes
 * `invoke(toolName, args)` which routes a `tools/call` to the owning server.
 * All I/O goes through an injected {@link McpTransport}, so unit tests script
 * responses in-memory with no subprocess. The default real stdio transport
 * lives behind {@link createStdioTransportFactory} and is not used by tests.
 */

import { spawn } from "node:child_process";

import {
  decodeContentLengthFrame,
  defaultInitializeParams,
  encodeContentLengthFrame,
  makeRequest,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeClientInfo,
  type McpInitializeResult,
  type McpListToolsParams,
  type McpListToolsResult,
  type McpListResourcesParams,
  type McpListResourcesResult,
  type McpReadResourceParams,
  type McpReadResourceResult,
  type McpTool,
  type McpToolCallParams,
  type McpToolCallResult,
} from "./protocol.js";
import { mcpToolName } from "./naming.js";
import { bridgeTools, type BridgedToolSpec } from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Transport abstraction (injectable)
// ---------------------------------------------------------------------------

/**
 * Bidirectional message transport for one MCP server session. Implementations
 * own the framing; the manager hands them already-built JSON-RPC envelopes and
 * receives parsed JSON-RPC envelopes back via {@link onMessage}.
 */
export type McpTransport = {
  /** Send one JSON-RPC request/notification envelope. */
  send(message: JsonRpcRequest<unknown>): Promise<void>;
  /** Register a handler for inbound JSON-RPC responses. */
  onMessage(handler: (message: JsonRpcResponse<unknown>) => void): void;
  /** Tear down the transport. Idempotent. */
  close(): void;
};

/** Describes how to construct a transport, mirroring the Rust client enum. */
export type McpTransportDescriptor =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "sse"; url: string; headers?: Record<string, string> }
  | { kind: "http"; url: string; headers?: Record<string, string> }
  | { kind: "websocket"; url: string; headers?: Record<string, string> };

/** Factory that builds a live transport from a descriptor. */
export type McpTransportFactory = (descriptor: McpTransportDescriptor) => McpTransport;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Failure raised by the manager, tagged with the server + method involved. */
export class McpClientError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

// ---------------------------------------------------------------------------
// Per-server session
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (response: JsonRpcResponse<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** Options for a managed server. */
export type McpServerOptions = {
  /** Per-request timeout in ms (0 disables). Defaults to 30_000. */
  requestTimeoutMs?: number;
  /** Override `initialize` clientInfo. */
  clientInfo?: McpInitializeClientInfo;
};

/**
 * One MCP server session bound to a transport. Drives `initialize`, paginated
 * `tools/list`/`resources/list`, `tools/call`, and `resources/read`.
 */
export class McpServerSession {
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: McpInitializeClientInfo | undefined;

  constructor(
    readonly serverName: string,
    private readonly transport: McpTransport,
    options: McpServerOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clientInfo = options.clientInfo;
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  private handleMessage(message: JsonRpcResponse<unknown>): void {
    if (message === undefined || message === null) return;
    const key = idKey(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private takeId(): JsonRpcId {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private request<TResult>(method: string, params?: unknown): Promise<JsonRpcResponse<TResult>> {
    const id = this.takeId();
    const key = idKey(id);
    const envelope = makeRequest(id, method, params);

    return new Promise<JsonRpcResponse<TResult>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(key);
          reject(new McpClientError(`MCP server \`${this.serverName}\` timed out during ${method}`, this.serverName, method));
        }, this.requestTimeoutMs);
        // Do not keep the event loop alive solely for this timer.
        if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
          (timer as { unref: () => void }).unref();
        }
      }
      this.pending.set(key, {
        resolve: resolve as (response: JsonRpcResponse<unknown>) => void,
        reject,
        timer,
      });
      this.transport.send(envelope).catch((error: unknown) => {
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        reject(
          error instanceof Error
            ? new McpClientError(error.message, this.serverName, method)
            : new McpClientError(String(error), this.serverName, method),
        );
      });
    });
  }

  /** Run `initialize` once; subsequent calls are no-ops. */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const response = await this.request<McpInitializeResult>(
      "initialize",
      defaultInitializeParams(this.clientInfo),
    );
    if (response.error) {
      throw new McpClientError(
        `MCP server \`${this.serverName}\` returned JSON-RPC error for initialize: ${response.error.message} (${response.error.code})`,
        this.serverName,
        "initialize",
      );
    }
    if (response.result === undefined) {
      throw new McpClientError(
        `MCP server \`${this.serverName}\` returned no result for initialize`,
        this.serverName,
        "initialize",
      );
    }
    this.initialized = true;
  }

  /** Discover all tools via paginated `tools/list`. */
  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const params: McpListToolsParams = {};
      if (cursor !== undefined) params.cursor = cursor;
      const response = await this.request<McpListToolsResult>("tools/list", params);
      const result = this.unwrap(response, "tools/list");
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  /** Invoke a tool by its RAW (server-local) name. */
  async callTool(rawName: string, args?: unknown): Promise<McpToolCallResult> {
    await this.ensureInitialized();
    const params: McpToolCallParams = { name: rawName };
    if (args !== undefined) params.arguments = args;
    const response = await this.request<McpToolCallResult>("tools/call", params);
    return this.unwrap(response, "tools/call");
  }

  /** Discover all resources via paginated `resources/list`. */
  async listResources(): Promise<McpListResourcesResult> {
    await this.ensureInitialized();
    const resources: McpListResourcesResult["resources"] = [];
    let cursor: string | undefined;
    do {
      const params: McpListResourcesParams = {};
      if (cursor !== undefined) params.cursor = cursor;
      const response = await this.request<McpListResourcesResult>("resources/list", params);
      const result = this.unwrap(response, "resources/list");
      resources.push(...result.resources);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return { resources };
  }

  /** Read a single resource by URI. */
  async readResource(uri: string): Promise<McpReadResourceResult> {
    await this.ensureInitialized();
    const params: McpReadResourceParams = { uri };
    const response = await this.request<McpReadResourceResult>("resources/read", params);
    return this.unwrap(response, "resources/read");
  }

  /** Close the underlying transport. */
  close(): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new McpClientError(`MCP server \`${this.serverName}\` session closed`, this.serverName, "close"));
    }
    this.pending.clear();
    this.transport.close();
  }

  private unwrap<T>(response: JsonRpcResponse<T>, method: string): T {
    if (response.error) {
      throw new McpClientError(
        `MCP server \`${this.serverName}\` returned JSON-RPC error for ${method}: ${response.error.message} (${response.error.code})`,
        this.serverName,
        method,
      );
    }
    if (response.result === undefined) {
      throw new McpClientError(
        `MCP server \`${this.serverName}\` returned no result for ${method}`,
        this.serverName,
        method,
      );
    }
    return response.result;
  }
}

// ---------------------------------------------------------------------------
// Multi-server manager
// ---------------------------------------------------------------------------

/** Route from a qualified tool name back to its server + raw tool name. */
type ToolRoute = { serverName: string; rawName: string };

/** Registration of one server: a name + an already-built transport. */
export type McpServerRegistration = {
  serverName: string;
  transport: McpTransport;
  options?: McpServerOptions;
};

/**
 * Drives several MCP server sessions, owns the qualified-name -> server routing
 * table, and exposes a single `discoverTools` / `invoke` surface. A
 * provider-neutral port of the Rust `McpServerManager`, but transport-injected.
 */
export class McpServerManager {
  private readonly sessions = new Map<string, McpServerSession>();
  private readonly toolIndex = new Map<string, ToolRoute>();

  /** Register a server with a pre-built (injected) transport. */
  registerServer(registration: McpServerRegistration): void {
    const session = new McpServerSession(registration.serverName, registration.transport, registration.options);
    this.sessions.set(registration.serverName, session);
  }

  /** Registered server names, in insertion order. */
  serverNames(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Initialize + list tools across every server, (re)building the routing
   * table. Returns the bridged, namespace-qualified tool specs.
   */
  async discoverTools(): Promise<BridgedToolSpec[]> {
    const discovered: BridgedToolSpec[] = [];
    for (const [serverName, session] of this.sessions) {
      this.clearRoutesForServer(serverName);
      const tools = await session.listTools();
      const specs = bridgeTools(serverName, tools);
      for (const spec of specs) {
        this.toolIndex.set(spec.qualifiedName, { serverName: spec.serverName, rawName: spec.rawName });
        discovered.push(spec);
      }
    }
    return discovered;
  }

  /**
   * Best-effort discovery: a failing server is collected rather than aborting
   * the whole sweep. Returns the surviving tools plus per-server failures.
   */
  async discoverToolsBestEffort(): Promise<{
    tools: BridgedToolSpec[];
    failedServers: { serverName: string; error: string }[];
  }> {
    const tools: BridgedToolSpec[] = [];
    const failedServers: { serverName: string; error: string }[] = [];
    for (const [serverName, session] of this.sessions) {
      this.clearRoutesForServer(serverName);
      try {
        const specs = bridgeTools(serverName, await session.listTools());
        for (const spec of specs) {
          this.toolIndex.set(spec.qualifiedName, { serverName: spec.serverName, rawName: spec.rawName });
          tools.push(spec);
        }
      } catch (error) {
        failedServers.push({ serverName, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { tools, failedServers };
  }

  /** Invoke a tool by its QUALIFIED name (`mcp__<server>__<tool>`). */
  async invoke(qualifiedToolName: string, args?: unknown): Promise<McpToolCallResult> {
    const route = this.toolIndex.get(qualifiedToolName);
    if (!route) {
      throw new McpClientError(`unknown MCP tool \`${qualifiedToolName}\``, "", "tools/call");
    }
    const session = this.sessions.get(route.serverName);
    if (!session) {
      throw new McpClientError(`unknown MCP server \`${route.serverName}\``, route.serverName, "tools/call");
    }
    return session.callTool(route.rawName, args);
  }

  /** Resolve a (server, rawTool) pair to its qualified name without invoking. */
  qualify(serverName: string, rawToolName: string): string {
    return mcpToolName(serverName, rawToolName);
  }

  /** Access a server session directly (e.g. for resource reads). */
  session(serverName: string): McpServerSession | undefined {
    return this.sessions.get(serverName);
  }

  /** Close every session. */
  shutdown(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.toolIndex.clear();
  }

  private clearRoutesForServer(serverName: string): void {
    for (const [qualified, route] of this.toolIndex) {
      if (route.serverName === serverName) this.toolIndex.delete(qualified);
    }
  }
}

// ---------------------------------------------------------------------------
// Default stdio transport (NOT exercised by tests)
// ---------------------------------------------------------------------------

/**
 * A real stdio transport that spawns a subprocess and speaks Content-Length
 * framing over its stdin/stdout. Lives behind {@link createStdioTransportFactory}
 * and is deliberately excluded from the hermetic unit tests.
 */
class StdioTransport implements McpTransport {
  private readonly child;
  private buffer = Buffer.alloc(0);
  private handler: ((message: JsonRpcResponse<unknown>) => void) | undefined;
  private closed = false;

  constructor(descriptor: Extract<McpTransportDescriptor, { kind: "stdio" }>) {
    this.child = spawn(descriptor.command, descriptor.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...(descriptor.env ?? {}) },
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk));
  }

  private onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain every complete frame currently buffered.
    for (;;) {
      const decoded = decodeContentLengthFrame<JsonRpcResponse<unknown>>(this.buffer);
      if (!decoded) break;
      this.buffer = this.buffer.subarray(decoded.bytesConsumed);
      if (this.handler && decoded.message !== undefined) this.handler(decoded.message);
    }
  }

  async send(message: JsonRpcRequest<unknown>): Promise<void> {
    if (this.closed) throw new Error("stdio transport is closed");
    const frame = encodeContentLengthFrame(message);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin?.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(handler: (message: JsonRpcResponse<unknown>) => void): void {
    this.handler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }
}

/**
 * Build the default transport factory. Only `stdio` is implemented; remote
 * transports (sse/http/ws) are described by the abstraction but throw here,
 * to be filled in when a real remote transport is wired up.
 */
export function createStdioTransportFactory(): McpTransportFactory {
  return (descriptor) => {
    if (descriptor.kind === "stdio") return new StdioTransport(descriptor);
    throw new Error(`MCP transport kind \`${descriptor.kind}\` is not yet implemented`);
  };
}

/** Stable string key for a JSON-RPC id (number/string/null collapse safely). */
function idKey(id: JsonRpcId): string {
  return id === null ? "null" : `${typeof id}:${id}`;
}
