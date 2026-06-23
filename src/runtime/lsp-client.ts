// LSP (Language Server Protocol) action registry and result types.
// Ported from claw-rust/crates/runtime/src/lsp_client.rs.
//
// This module provides the registry + types only — no live LSP JSON-RPC
// transport is implemented here. Actual protocol communication would be
// layered on top by a concrete client adapter.

// ---------------------------------------------------------------------------
// Discriminated-union action enum
// ---------------------------------------------------------------------------

export type LspAction =
  | { kind: "diagnostics" }
  | { kind: "hover" }
  | { kind: "definition" }
  | { kind: "references" }
  | { kind: "completion" }
  | { kind: "symbols" }
  | { kind: "format" };

export type LspActionKind = LspAction["kind"];

/**
 * Parse a string alias into an LspAction, handling the aliases supported by
 * the Rust port (e.g. "goto_definition" → definition, "formatting" → format).
 * Returns undefined for unknown strings.
 */
export function lspActionFromString(s: string): LspAction | undefined {
  switch (s) {
    case "diagnostics":
      return { kind: "diagnostics" };
    case "hover":
      return { kind: "hover" };
    case "definition":
    case "goto_definition":
      return { kind: "definition" };
    case "references":
    case "find_references":
      return { kind: "references" };
    case "completion":
    case "completions":
      return { kind: "completion" };
    case "symbols":
    case "document_symbols":
      return { kind: "symbols" };
    case "format":
    case "formatting":
      return { kind: "format" };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type LspDiagnostic = {
  path: string;
  line: number;
  character: number;
  severity: string;
  message: string;
  source: string | undefined;
};

export type LspLocation = {
  path: string;
  line: number;
  character: number;
  endLine: number | undefined;
  endCharacter: number | undefined;
  preview: string | undefined;
};

export type LspHoverResult = {
  content: string;
  language: string | undefined;
};

export type LspCompletionItem = {
  label: string;
  kind: string | undefined;
  detail: string | undefined;
  insertText: string | undefined;
};

export type LspSymbol = {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
};

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

export type LspServerStatus =
  | { kind: "connected" }
  | { kind: "disconnected" }
  | { kind: "starting" }
  | { kind: "error" };

export type LspServerStatusKind = LspServerStatus["kind"];

export function lspServerStatusToString(status: LspServerStatus): string {
  return status.kind;
}

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

export type LspServerState = {
  language: string;
  status: LspServerStatus;
  rootPath: string | undefined;
  capabilities: string[];
  diagnostics: LspDiagnostic[];
};

// ---------------------------------------------------------------------------
// Extension → language mapping (mirrors Rust source)
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  ["rs", "rust"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["py", "python"],
  ["go", "go"],
  ["java", "java"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["hpp", "cpp"],
  ["cc", "cpp"],
  ["rb", "ruby"],
  ["lua", "lua"],
]);

function languageForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE.get(ext);
}

// ---------------------------------------------------------------------------
// Dispatch result type
// ---------------------------------------------------------------------------

export type LspDispatchResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// LspRegistry
// ---------------------------------------------------------------------------

/** Thread-safe registry of LSP server states, with action dispatch. */
export class LspRegistry {
  private readonly servers = new Map<string, LspServerState>();

  /** Register or replace a server entry for the given language. */
  register(
    language: string,
    status: LspServerStatus,
    rootPath: string | undefined,
    capabilities: string[],
  ): void {
    this.servers.set(language, {
      language,
      status,
      rootPath,
      capabilities,
      diagnostics: [],
    });
  }

  /** Retrieve the server state for a language, or undefined. */
  get(language: string): LspServerState | undefined {
    const entry = this.servers.get(language);
    return entry === undefined ? undefined : { ...entry, diagnostics: [...entry.diagnostics] };
  }

  /** Find the server that handles files with the given path's extension. */
  findServerForPath(filePath: string): LspServerState | undefined {
    const lang = languageForPath(filePath);
    return lang === undefined ? undefined : this.get(lang);
  }

  /** List all registered server states (order is insertion order). */
  listServers(): LspServerState[] {
    return Array.from(this.servers.values()).map((s) => ({
      ...s,
      diagnostics: [...s.diagnostics],
    }));
  }

  /** Append diagnostics to the named language server. Returns an error string if not found. */
  addDiagnostics(language: string, diagnostics: LspDiagnostic[]): string | undefined {
    const server = this.servers.get(language);
    if (server === undefined) return `LSP server not found for language: ${language}`;
    server.diagnostics.push(...diagnostics);
    return undefined;
  }

  /** Get all diagnostics for a specific file path across all servers. */
  getDiagnostics(filePath: string): LspDiagnostic[] {
    const result: LspDiagnostic[] = [];
    for (const server of this.servers.values()) {
      for (const d of server.diagnostics) {
        if (d.path === filePath) result.push({ ...d });
      }
    }
    return result;
  }

  /** Clear diagnostics for the named language server. Returns an error string if not found. */
  clearDiagnostics(language: string): string | undefined {
    const server = this.servers.get(language);
    if (server === undefined) return `LSP server not found for language: ${language}`;
    server.diagnostics = [];
    return undefined;
  }

  /** Remove a server from the registry. Returns the removed state, or undefined. */
  disconnect(language: string): LspServerState | undefined {
    const server = this.servers.get(language);
    if (server === undefined) return undefined;
    this.servers.delete(language);
    return { ...server, diagnostics: [...server.diagnostics] };
  }

  get size(): number {
    return this.servers.size;
  }

  get isEmpty(): boolean {
    return this.servers.size === 0;
  }

  /**
   * Dispatch an LSP action by name and return a structured result object.
   *
   * For `diagnostics`, a path is optional; omitting it aggregates across all
   * servers. All other actions require a path.
   *
   * Returns `{ ok: true, value }` on success or `{ ok: false, error }` on failure.
   */
  dispatch(
    action: string,
    path: string | undefined,
    line: number | undefined,
    character: number | undefined,
    _query: string | undefined,
  ): { ok: true; value: LspDispatchResult } | { ok: false; error: string } {
    const lspAction = lspActionFromString(action);
    if (lspAction === undefined) {
      return { ok: false, error: `unknown LSP action: ${action}` };
    }

    if (lspAction.kind === "diagnostics") {
      if (path !== undefined) {
        const diags = this.getDiagnostics(path);
        return {
          ok: true,
          value: { action: "diagnostics", path, diagnostics: diags, count: diags.length },
        };
      }
      const allDiags: LspDiagnostic[] = [];
      for (const server of this.servers.values()) {
        allDiags.push(...server.diagnostics);
      }
      return {
        ok: true,
        value: { action: "diagnostics", diagnostics: allDiags, count: allDiags.length },
      };
    }

    if (path === undefined) {
      return { ok: false, error: "path is required for this LSP action" };
    }

    const server = this.findServerForPath(path);
    if (server === undefined) {
      return { ok: false, error: `no LSP server available for path: ${path}` };
    }

    if (server.status.kind !== "connected") {
      return {
        ok: false,
        error: `LSP server for '${server.language}' is not connected (status: ${server.status.kind})`,
      };
    }

    return {
      ok: true,
      value: {
        action,
        path,
        line,
        character,
        language: server.language,
        status: "dispatched",
        message: `LSP ${action} dispatched to ${server.language} server`,
      },
    };
  }
}
