/**
 * `solarcido lsp <file>` — open a file in a language server and print its
 * diagnostics. The session-driving logic (`collectDiagnostics`) takes an
 * injectable session so it is testable without spawning a real server; the CLI
 * entry (`runLspDiagnosticsCommand`) wires it to a real stdio language server.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { LspClientSession, createLspStdioTransportFactory } from "../runtime/lsp/client.js";
import type { LspDiagnostic } from "../runtime/lsp-client.js";

export type LspServerCommand = { command: string; args?: string[] };

const SERVERS: Readonly<Record<string, LspServerCommand>> = {
  ".ts": { command: "typescript-language-server", args: ["--stdio"] },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"] },
  ".js": { command: "typescript-language-server", args: ["--stdio"] },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"] },
  ".py": { command: "pylsp", args: [] },
  ".rs": { command: "rust-analyzer", args: [] },
  ".go": { command: "gopls", args: [] },
};

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".json": "json",
  ".md": "markdown",
};

export function defaultServerForFile(file: string): LspServerCommand | undefined {
  return SERVERS[path.extname(file).toLowerCase()];
}

export function languageIdForFile(file: string): string {
  return LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? "plaintext";
}

/** Convert an absolute filesystem path to a `file://` URI (round-trips with uriToPath). */
export function pathToFileUri(filePath: string): string {
  let resolved = path.resolve(filePath).replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(resolved)) resolved = `/${resolved}`;
  const encoded = resolved
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encoded}`;
}

/** Minimal session surface used by the diagnostics driver (matches LspClientSession). */
export type LspSessionLike = {
  initialize(rootUri: string): Promise<void>;
  didOpen(uri: string, languageId: string, text: string): Promise<void>;
  diagnostics(uri: string): LspDiagnostic[];
  shutdown(): Promise<void>;
};

export type CollectDiagnosticsOptions = {
  languageId?: string;
  rootUri?: string;
  /** How long to wait for the server to push diagnostics (default 0 here; the CLI uses ~1500ms). */
  settleMs?: number;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Drive a session to collect diagnostics for a file's text. Injectable session = testable. */
export async function collectDiagnostics(
  session: LspSessionLike,
  filePath: string,
  text: string,
  options: CollectDiagnosticsOptions = {},
): Promise<LspDiagnostic[]> {
  const uri = pathToFileUri(filePath);
  const rootUri = options.rootUri ?? pathToFileUri(path.dirname(path.resolve(filePath)));
  const languageId = options.languageId ?? languageIdForFile(filePath);

  await session.initialize(rootUri);
  await session.didOpen(uri, languageId, text);
  if (options.settleMs && options.settleMs > 0) {
    await delay(options.settleMs);
  }
  const diagnostics = session.diagnostics(uri);
  await session.shutdown();
  return diagnostics;
}

export function formatDiagnostics(file: string, diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return `No diagnostics for ${file}.`;
  }
  const lines = [`${diagnostics.length} diagnostic(s) for ${file}:`];
  for (const diagnostic of diagnostics) {
    const source = diagnostic.source ? ` (${diagnostic.source})` : "";
    lines.push(`  ${diagnostic.line + 1}:${diagnostic.character + 1} ${diagnostic.severity}: ${diagnostic.message}${source}`);
  }
  return lines.join("\n");
}

/** Parse a `--server` string like `typescript-language-server --stdio` into a command. */
export function parseServerCommand(raw: string | undefined): LspServerCommand | undefined {
  if (!raw) return undefined;
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return undefined;
  return { command: parts[0], args: parts.slice(1) };
}

export type RunLspDiagnosticsCommandOptions = {
  file: string;
  server?: string;
  settleMs?: number;
};

/** CLI entry: spawn a real language server and print the file's diagnostics. */
export async function runLspDiagnosticsCommand(options: RunLspDiagnosticsCommandOptions): Promise<string> {
  const absFile = path.resolve(options.file);
  const text = readFileSync(absFile, "utf8");
  const server = parseServerCommand(options.server) ?? defaultServerForFile(absFile);
  if (!server) {
    throw new Error(`No language server is known for ${absFile}; pass --server "<command>".`);
  }

  const factory = createLspStdioTransportFactory();
  const transport = factory({
    kind: "stdio",
    command: server.command,
    args: server.args,
    cwd: path.dirname(absFile),
  });
  const session = new LspClientSession(transport);
  const diagnostics = await collectDiagnostics(session, absFile, text, { settleMs: options.settleMs ?? 1500 });
  return formatDiagnostics(absFile, diagnostics);
}
