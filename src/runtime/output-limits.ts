/**
 * Caps on tool-result size before it enters the model transcript.
 *
 * solar-pro3's real context window is 131,072 tokens (measured against the live
 * API). A single unbounded tool result can blow the whole window in one call —
 * `read_file` returns up to ~1 MB and `run_command` buffers up to 4 MB — so
 * every tool result is clamped here first. Limits are expressed in characters
 * (not bytes) so truncation never splits a multi-byte code point; the values are
 * deliberately well under the window to leave room for the rest of the
 * conversation and the model's reply.
 */

/** Per-section cap for command stdout/stderr (~3–4K tokens each). */
export const MAX_COMMAND_STREAM_CHARS = 16_000;
/** Cap for the full-content path of read_file (~20K tokens). */
export const MAX_READ_OUTPUT_CHARS = 100_000;
/** Cap for the search_files match list (~8K tokens). */
export const MAX_SEARCH_OUTPUT_CHARS = 40_000;

export type ClampMode = "head" | "head-tail";

/**
 * Returns `text` unchanged when it fits within `maxChars`, otherwise truncates
 * it and inserts a visible marker stating how much was dropped.
 *
 * - `"head"` keeps the beginning (best for file contents / match lists).
 * - `"head-tail"` keeps the start and the end (best for command output, where
 *   errors usually surface at the tail).
 */
export function clampText(
  text: string,
  maxChars: number,
  mode: ClampMode = "head",
  hint = "",
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  const suffix = hint ? ` — ${hint}` : "";
  const marker = `\n…[${omitted} characters truncated${suffix}]…\n`;

  if (mode === "head-tail") {
    const headChars = Math.ceil(maxChars * 0.7);
    const tailChars = maxChars - headChars;
    return text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
  }

  return text.slice(0, maxChars) + marker;
}
