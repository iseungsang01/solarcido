/**
 * LSP (Language Server Protocol) client session over an INJECTED transport.
 *
 * Mirrors the MCP client design in `../mcp/client.ts`: an injectable transport,
 * a pending-request map keyed by JSON-RPC id, per-request timeouts (unref'd),
 * and a real stdio transport that lives behind a factory and is NOT exercised
 * by the hermetic unit tests.
 *
 * LSP speaks JSON-RPC 2.0 over `Content-Length` framing — the SAME framing the
 * MCP stdio transport uses — so this module reuses
 * `encodeContentLengthFrame`/`decodeContentLengthFrame` and the JSON-RPC
 * envelope types from `../mcp/protocol.js` rather than reimplementing them.
 *
 * The session drives the standard handshake:
 *   `initialize` (request) -> `initialized` (notification) -> per-document
 *   `textDocument/didOpen` (notification) -> `textDocument/hover` and
 *   `textDocument/definition` (requests). `textDocument/publishDiagnostics`
 *   notifications pushed by the server are collected per-URI and surfaced via
 *   {@link LspClientSession.diagnostics}.
 *
 * Wire results are mapped onto the existing result types in
 * `../lsp-client.js` ({@link LspDiagnostic}, {@link LspLocation},
 * {@link LspHoverResult}) wherever they fit.
 */

import { spawn } from "node:child_process";

import {
  decodeContentLengthFrame,
  encodeContentLengthFrame,
  makeRequest,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../mcp/protocol.js";
import type {
  LspDiagnostic,
  LspHoverResult,
  LspLocation,
} from "../lsp-client.js";

// ---------------------------------------------------------------------------
// Transport abstraction (injectable)
// ---------------------------------------------------------------------------

/**
 * One LSP server connection. The session hands the transport already-built
 * JSON-RPC request/notification envelopes and receives parsed JSON-RPC
 * envelopes (responses *and* server-originated notifications/requests) back via
 * {@link onMessage}. Implementations own the framing.
 */
export type LspTransport = {
  /** Send one JSON-RPC request or notification envelope. */
  send(message: JsonRpcRequest<unknown> | JsonRpcNotification<unknown>): Promise<void>;
  /** Register a handler for every inbound JSON-RPC envelope. */
  onMessage(handler: (message: LspInboundMessage) => void): void;
  /** Tear down the transport. Idempotent. */
  close(): void;
};

/**
 * Inbound envelopes can be responses (have `id` matching a pending request) or
 * server-originated notifications/requests (have `method`). We model the union
 * loosely so the session can branch on the presence of `method` vs `id`.
 */
export type LspInboundMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Describes how to construct a stdio transport from a language-server command. */
export type LspTransportDescriptor = {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

/** Factory that builds a live transport from a descriptor. */
export type LspTransportFactory = (descriptor: LspTransportDescriptor) => LspTransport;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Failure raised by the session, tagged with the LSP method involved. */
export class LspClientError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "LspClientError";
  }
}

// ---------------------------------------------------------------------------
// Minimal LSP wire types (only the fields this session reads)
// ---------------------------------------------------------------------------

/** Zero-based line/character position, per the LSP spec. */
export type LspPosition = { line: number; character: number };

type LspRange = { start: LspPosition; end: LspPosition };

type LspWireDiagnostic = {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
};

type PublishDiagnosticsParams = {
  uri: string;
  diagnostics: LspWireDiagnostic[];
};

type MarkupContent = { kind: string; value: string };

type LspWireHover = {
  contents: string | MarkedString | MarkedString[] | MarkupContent;
  range?: LspRange;
} | null;

type MarkedString = string | { language: string; value: string };

type LspWireLocation = {
  uri: string;
  range: LspRange;
};

type LspWireLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};

// `textDocument/definition` may return Location, Location[], LocationLink[], or null.
type DefinitionResult = LspWireLocation | LspWireLocation[] | LspWireLocationLink[] | null;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Map an LSP `DiagnosticSeverity` number to the string the registry expects. */
const SEVERITY_NAMES: Readonly<Record<number, string>> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

function severityName(severity: number | undefined): string {
  if (severity === undefined) return "error";
  return SEVERITY_NAMES[severity] ?? "error";
}

type PendingRequest = {
  resolve: (response: JsonRpcResponse<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** Options for an LSP session. */
export type LspSessionOptions = {
  /** Per-request timeout in ms (0 disables). Defaults to 30_000. */
  requestTimeoutMs?: number;
  /** clientInfo advertised in `initialize`. */
  clientInfo?: { name: string; version: string };
};

const DEFAULT_CLIENT_INFO = { name: "solarcido", version: "0.1.0" } as const;

/**
 * One LSP server session bound to a transport. Drives `initialize` /
 * `initialized`, `textDocument/didOpen`, `textDocument/hover`,
 * `textDocument/definition`, and collects `textDocument/publishDiagnostics`.
 */
export class LspClientSession {
  private nextId = 1;
  private initialized = false;
  private documentVersions = new Map<string, number>();
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: { name: string; version: string };

  constructor(
    private readonly transport: LspTransport,
    options: LspSessionOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  // -- inbound dispatch -----------------------------------------------------

  private handleMessage(message: LspInboundMessage): void {
    if (message === undefined || message === null) return;

    // Server-originated notification (no id, has method): handle the ones we
    // care about (publishDiagnostics); ignore the rest (logs, progress, etc.).
    if (message.method !== undefined && message.id === undefined) {
      if (message.method === "textDocument/publishDiagnostics") {
        this.onPublishDiagnostics(message.params as PublishDiagnosticsParams | undefined);
      }
      return;
    }

    // Response to one of our requests.
    if (message.id !== undefined) {
      const key = idKey(message.id);
      const pending = this.pending.get(key);
      if (!pending) return; // unmatched id or a server->client request we don't serve
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(message as JsonRpcResponse<unknown>);
    }
  }

  private onPublishDiagnostics(params: PublishDiagnosticsParams | undefined): void {
    if (!params || typeof params.uri !== "string") return;
    const mapped = (params.diagnostics ?? []).map((d) => this.mapDiagnostic(params.uri, d));
    this.diagnosticsByUri.set(params.uri, mapped);
  }

  private mapDiagnostic(uri: string, d: LspWireDiagnostic): LspDiagnostic {
    return {
      path: uriToPath(uri),
      line: d.range.start.line,
      character: d.range.start.character,
      severity: severityName(d.severity),
      message: d.message,
      source: d.source,
    };
  }

  // -- request plumbing -----------------------------------------------------

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
          reject(new LspClientError(`LSP request \`${method}\` timed out`, method));
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
            ? new LspClientError(error.message, method)
            : new LspClientError(String(error), method),
        );
      });
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const envelope: JsonRpcNotification<unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) envelope.params = params;
    await this.transport.send(envelope);
  }

  private unwrap<T>(response: JsonRpcResponse<T>, method: string): T {
    if (response.error) {
      throw new LspClientError(
        `LSP server returned JSON-RPC error for ${method}: ${response.error.message} (${response.error.code})`,
        method,
      );
    }
    if (response.result === undefined) {
      throw new LspClientError(`LSP server returned no result for ${method}`, method);
    }
    return response.result;
  }

  // -- public API -----------------------------------------------------------

  /**
   * Run the `initialize` request followed by the `initialized` notification
   * once. `rootUri` is a `file://` URI for the workspace root. Subsequent calls
   * are no-ops.
   */
  async initialize(rootUri: string): Promise<void> {
    if (this.initialized) return;
    const params = {
      processId: typeof process !== "undefined" && process.pid ? process.pid : null,
      clientInfo: this.clientInfo,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { workspaceFolders: false },
      },
      workspaceFolders: null,
    };
    const response = await this.request<unknown>("initialize", params);
    this.unwrap(response, "initialize");
    this.initialized = true;
    await this.notify("initialized", {});
  }

  /**
   * Open a document on the server via `textDocument/didOpen`. Re-opening the
   * same URI bumps its version. This is a notification (no response).
   */
  async didOpen(uri: string, languageId: string, text: string): Promise<void> {
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    this.documentVersions.set(uri, version);
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /**
   * Request hover info at `position` (zero-based). Returns the mapped
   * {@link LspHoverResult} or `null` when the server reports no hover.
   */
  async hover(uri: string, position: LspPosition): Promise<LspHoverResult | null> {
    const response = await this.request<LspWireHover>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    const wire = this.unwrapNullable(response, "textDocument/hover");
    if (wire === null || wire === undefined) return null;
    return mapHover(wire);
  }

  /**
   * Request go-to-definition at `position` (zero-based). Returns a list of
   * {@link LspLocation} (possibly empty), normalizing the several shapes LSP
   * permits (single Location, Location[], LocationLink[]).
   */
  async definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    const response = await this.request<DefinitionResult>("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    const wire = this.unwrapNullable(response, "textDocument/definition");
    return mapDefinition(wire ?? null);
  }

  /**
   * Diagnostics most recently published by the server for `uri`. Empty when the
   * server has not (yet) published any. The session is push-driven, so callers
   * read this after giving the server a chance to emit publishDiagnostics.
   */
  diagnostics(uri: string): LspDiagnostic[] {
    return (this.diagnosticsByUri.get(uri) ?? []).map((d) => ({ ...d }));
  }

  /**
   * Gracefully tell the server to `shutdown` then `exit`, and close the
   * transport. Rejects any in-flight requests.
   */
  async shutdown(): Promise<void> {
    if (this.initialized) {
      try {
        await this.request<null>("shutdown");
        await this.notify("exit");
      } catch {
        // Best-effort: a server that is already gone should not block teardown.
      }
    }
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new LspClientError("LSP session closed", "shutdown"));
    }
    this.pending.clear();
    this.initialized = false;
    this.transport.close();
  }

  /** Like {@link unwrap} but tolerates a `null` result (hover/definition). */
  private unwrapNullable<T>(response: JsonRpcResponse<T>, method: string): T | null {
    if (response.error) {
      throw new LspClientError(
        `LSP server returned JSON-RPC error for ${method}: ${response.error.message} (${response.error.code})`,
        method,
      );
    }
    return (response.result ?? null) as T | null;
  }
}

// ---------------------------------------------------------------------------
// Wire -> result mapping (pure helpers)
// ---------------------------------------------------------------------------

/** Flatten the several `Hover.contents` shapes into a single string + language. */
function mapHover(wire: NonNullable<LspWireHover>): LspHoverResult {
  const contents = wire.contents;

  // MarkupContent: { kind, value }
  if (isMarkupContent(contents)) {
    return { content: contents.value, language: undefined };
  }

  // Single MarkedString.
  if (typeof contents === "string") {
    return { content: contents, language: undefined };
  }
  if (isMarkedStringObject(contents)) {
    return { content: contents.value, language: contents.language };
  }

  // MarkedString[].
  if (Array.isArray(contents)) {
    const parts: string[] = [];
    let language: string | undefined;
    for (const part of contents) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (isMarkedStringObject(part)) {
        parts.push(part.value);
        if (language === undefined) language = part.language;
      }
    }
    return { content: parts.join("\n"), language };
  }

  return { content: "", language: undefined };
}

function isMarkupContent(value: unknown): value is MarkupContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "value" in value &&
    typeof (value as MarkupContent).value === "string"
  );
}

function isMarkedStringObject(value: unknown): value is { language: string; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "language" in value &&
    "value" in value &&
    typeof (value as { value: unknown }).value === "string"
  );
}

/** Normalize the Location / Location[] / LocationLink[] union into LspLocation[]. */
function mapDefinition(wire: DefinitionResult): LspLocation[] {
  if (wire === null || wire === undefined) return [];
  const list = Array.isArray(wire) ? wire : [wire];
  return list.map((entry) => {
    if (isLocationLink(entry)) {
      const range = entry.targetSelectionRange ?? entry.targetRange;
      return locationFrom(entry.targetUri, range);
    }
    return locationFrom(entry.uri, entry.range);
  });
}

function isLocationLink(entry: LspWireLocation | LspWireLocationLink): entry is LspWireLocationLink {
  return "targetUri" in entry;
}

function locationFrom(uri: string, range: LspRange): LspLocation {
  return {
    path: uriToPath(uri),
    line: range.start.line,
    character: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    preview: undefined,
  };
}

// ---------------------------------------------------------------------------
// file:// URI <-> path (best-effort, deterministic)
// ---------------------------------------------------------------------------

/**
 * Convert a `file://` URI to a filesystem path. Non-`file:` URIs and bare paths
 * are returned unchanged so the mapping is total and never throws.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let rest = uri.slice("file://".length);
  // file:///C:/x -> host is empty, path begins after the third slash.
  // Strip a leading authority component if present (file://host/path).
  if (!rest.startsWith("/")) {
    const slash = rest.indexOf("/");
    rest = slash === -1 ? "" : rest.slice(slash);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    decoded = rest;
  }
  // Windows drive paths arrive as `/C:/x` -> `C:/x`.
  if (/^\/[A-Za-z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Default stdio transport (NOT exercised by tests)
// ---------------------------------------------------------------------------

/**
 * A real stdio transport that spawns a language-server subprocess and speaks
 * Content-Length-framed JSON-RPC over its stdin/stdout. Lives behind
 * {@link createLspStdioTransportFactory} and is deliberately excluded from the
 * hermetic unit tests.
 */
class LspStdioTransport implements LspTransport {
  private readonly child;
  private buffer = Buffer.alloc(0);
  private handler: ((message: LspInboundMessage) => void) | undefined;
  private closed = false;

  constructor(descriptor: LspTransportDescriptor) {
    this.child = spawn(descriptor.command, descriptor.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...(descriptor.env ?? {}) },
      cwd: descriptor.cwd,
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk));
  }

  private onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain every complete frame currently buffered.
    for (;;) {
      const decoded = decodeContentLengthFrame<LspInboundMessage>(this.buffer);
      if (!decoded) break;
      this.buffer = this.buffer.subarray(decoded.bytesConsumed);
      if (this.handler && decoded.message !== undefined) this.handler(decoded.message);
    }
  }

  async send(message: JsonRpcRequest<unknown> | JsonRpcNotification<unknown>): Promise<void> {
    if (this.closed) throw new Error("LSP stdio transport is closed");
    const frame = encodeContentLengthFrame(message);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin?.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(handler: (message: LspInboundMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }
}

/**
 * Build the default LSP transport factory. Spawns the given language-server
 * command and frames JSON-RPC over its stdio. Not used by the hermetic tests.
 */
export function createLspStdioTransportFactory(): LspTransportFactory {
  return (descriptor) => {
    if (descriptor.kind === "stdio") return new LspStdioTransport(descriptor);
    throw new Error(`LSP transport kind \`${(descriptor as { kind: string }).kind}\` is not supported`);
  };
}

/** Stable string key for a JSON-RPC id (number/string/null collapse safely). */
function idKey(id: JsonRpcId | undefined): string {
  if (id === undefined || id === null) return "null";
  return `${typeof id}:${id}`;
}
