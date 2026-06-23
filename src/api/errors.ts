/**
 * API error taxonomy, ported provider-neutral from claw-rust `crates/api/src/error.rs`
 * and adapted to the OpenAI-compatible SDK error shapes the Upstage client surfaces.
 *
 * The Rust original is Anthropic-specific (OAuth, `reqwest::Error`, `ANTHROPIC_*`
 * credentials). Here we keep only the *classification* — enough for the conversation
 * loop to log a clean failure reason and to decide retry-vs-fail — seeded with
 * Solar/OpenAI shapes (numeric `status`, `code`, `request_id`, message markers).
 */

export type ApiErrorKind =
  | "auth"
  | "rate-limit"
  | "context-window"
  | "retryable"
  | "json"
  | "io"
  | "timeout"
  | "unknown";

export type ClassifiedApiError = {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
};

/** Substring markers (case-insensitive) that signal a context-window overflow. */
const CONTEXT_WINDOW_MARKERS = [
  "maximum context length",
  "context window",
  "context length",
  "too many tokens",
  "prompt is too long",
  "input is too long",
  "request is too large",
] as const;

/** Node fs/io error codes that should classify as `io` rather than a transport retry. */
const IO_CODES = new Set(["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "EEXIST", "EPERM"]);

function looksLikeContextWindow(text: string): boolean {
  const lowered = text.toLowerCase();
  return CONTEXT_WINDOW_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Classify an arbitrary thrown value into the provider-neutral taxonomy.
 * Never throws; falls back to `unknown`.
 */
export function classifyApiError(error: unknown): ClassifiedApiError {
  if (typeof error === "string") {
    return classifyFields({ message: error });
  }
  if (!error || typeof error !== "object") {
    return { kind: "unknown", message: String(error) };
  }

  const e = error as Record<string, unknown>;
  const message = typeof e.message === "string" && e.message.length > 0 ? e.message : String(error);
  const name = typeof e.name === "string" ? e.name : "";
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? (e.statusCode as number)
        : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  const requestId =
    typeof e.request_id === "string"
      ? e.request_id
      : typeof e.requestID === "string"
        ? (e.requestID as string)
        : undefined;

  return classifyFields({ message, name, status, code, requestId, isSyntaxError: error instanceof SyntaxError });
}

function classifyFields(input: {
  message: string;
  name?: string;
  status?: number;
  code?: string;
  requestId?: string;
  isSyntaxError?: boolean;
}): ClassifiedApiError {
  const { message } = input;
  const name = input.name ?? "";
  const code = input.code;
  const base: ClassifiedApiError = {
    kind: "unknown",
    message,
    status: input.status,
    code,
    requestId: input.requestId,
  };

  // Transport: timeout vs. generic connection failure (both pre-status).
  if (name.includes("Timeout") || code === "ETIMEDOUT" || /timed?\s?out/i.test(message)) {
    return { ...base, kind: "timeout" };
  }
  if (name === "APIConnectionError" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
    return { ...base, kind: "retryable" };
  }
  if (code && IO_CODES.has(code)) {
    return { ...base, kind: "io" };
  }

  // HTTP status driven classification.
  if (typeof input.status === "number") {
    if (input.status === 401 || input.status === 403) return { ...base, kind: "auth" };
    if (input.status === 429) return { ...base, kind: "rate-limit" };
    if ((input.status === 400 || input.status === 413 || input.status === 422) && looksLikeContextWindow(message)) {
      return { ...base, kind: "context-window" };
    }
    if (input.status >= 500) return { ...base, kind: "retryable" };
  }

  // Missing/invalid credentials without an HTTP status (e.g. local key check).
  if (/api[_\s]?key/i.test(message) && /required|missing|not set|invalid/i.test(message)) {
    return { ...base, kind: "auth" };
  }

  // Malformed JSON response.
  if (input.isSyntaxError || /\bjson\b/i.test(name) || /unexpected token.*json/i.test(message)) {
    return { ...base, kind: "json" };
  }

  // Context-window signalled in the message without a recognised status.
  if (looksLikeContextWindow(message)) {
    return { ...base, kind: "context-window" };
  }

  return base;
}

/** Whether a classified error is worth retrying. */
export function isRetryable(error: ClassifiedApiError): boolean {
  return error.kind === "rate-limit" || error.kind === "retryable" || error.kind === "timeout";
}

/** Compact, log-friendly one-line summary. */
export function formatClassifiedError(error: ClassifiedApiError): string {
  const parts = [`[${error.kind}]`];
  if (typeof error.status === "number") parts.push(`(${error.status})`);
  parts.push(error.message);
  if (error.requestId) parts.push(`[trace ${error.requestId}]`);
  return parts.join(" ");
}
