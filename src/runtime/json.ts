// JSON helpers for Solarcido.
// Ported (selectively) from claw-rust/crates/runtime/src/json.rs.
//
// The Rust module contains a hand-rolled parser and renderer because serde_json
// wasn't available in that build context. In TypeScript JSON.parse / JSON.stringify
// already handle parsing and rendering, so we port only the useful surface:
//
//   • JsonResult<T>  — a result union (ok / err) so callers never have to try/catch.
//   • safeParse      — wraps JSON.parse into a JsonResult.
//   • safeStringify  — wraps JSON.stringify into a JsonResult.
//   • renderCompact  — alias for JSON.stringify with sorted keys (mirrors render()).

// ---------------------------------------------------------------------------
// Result union
// ---------------------------------------------------------------------------

/** Successful parse outcome. */
export type JsonOk<T> = { ok: true; value: T };

/** Failed parse outcome. */
export type JsonErr = { ok: false; error: string };

/** Discriminated result union returned by safe JSON helpers. */
export type JsonResult<T> = JsonOk<T> | JsonErr;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string without throwing. Returns `{ ok: true, value }` on
 * success and `{ ok: false, error }` on any parse failure.
 *
 * @example
 * const result = safeParse('{"x":1}');
 * if (result.ok) console.log(result.value.x); // 1
 */
export function safeParse<T = unknown>(source: string): JsonResult<T> {
  try {
    return { ok: true, value: JSON.parse(source) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Serialize a value to JSON without throwing. Returns `{ ok: true, value }`
 * on success and `{ ok: false, error }` if the value is not serialisable
 * (e.g. contains a circular reference or a BigInt).
 */
export function safeStringify(value: unknown, indent?: number): JsonResult<string> {
  try {
    return { ok: true, value: JSON.stringify(value, null, indent) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Render a value as compact JSON with keys sorted alphabetically.
 *
 * Mirrors the deterministic output of `JsonValue::render` from the Rust port.
 * Returns `null` for non-serialisable values rather than throwing.
 */
export function renderCompact(value: unknown): string | null {
  try {
    return JSON.stringify(sortKeysDeep(value));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: deep key sort
// ---------------------------------------------------------------------------

/** Recursively sort object keys so renderCompact output is deterministic. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
