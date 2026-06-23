// Cron expression parser and matcher (5-field standard format).
// Fields: minute hour day-of-month month day-of-week
// Supported syntax: `*`, lists `a,b`, ranges `a-b`, steps `*/n` and `a-b/n`.
//
// Matching is pure/deterministic — callers pass the Date; this module never
// calls `new Date()` with no args. All field matching uses UTC getters so
// behaviour is consistent regardless of the host timezone.
//
// Day-of-month / day-of-week convention: when both fields are restricted (not
// `*`), a minute matches if EITHER condition is true (standard cron semantics).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed cron field represented as an expanded set of allowed values. */
type FieldSet = {
  readonly values: ReadonlySet<number>;
  /** true when the original field was a bare `*` (affects DoM/DoW OR logic) */
  readonly isStar: boolean;
};

/** A fully parsed 5-field cron expression. */
export type CronExpression = {
  readonly minute: FieldSet;     // 0–59
  readonly hour: FieldSet;       // 0–23
  readonly dayOfMonth: FieldSet; // 1–31
  readonly month: FieldSet;      // 1–12
  readonly dayOfWeek: FieldSet;  // 0–6 (0 = Sunday)
};

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

type FieldBounds = { min: number; max: number };

const BOUNDS: Record<string, FieldBounds> = {
  minute:     { min: 0, max: 59 },
  hour:       { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month:      { min: 1, max: 12 },
  dayOfWeek:  { min: 0, max: 6  },
};

const FIELD_NAMES = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"] as const;
type FieldName = (typeof FIELD_NAMES)[number];

// ---------------------------------------------------------------------------
// Field parser
// ---------------------------------------------------------------------------

function parseField(raw: string, bounds: FieldBounds): FieldSet {
  const { min, max } = bounds;

  // bare `*`
  if (raw === "*") {
    return { values: fullRange(min, max), isStar: true };
  }

  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") throw new Error(`empty segment in field: "${raw}"`);

    // step: */n or a-b/n
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseIntStrict(stepStr);
      if (step <= 0) throw new Error(`step must be >= 1, got ${stepStr}`);

      const rangeStr = trimmed.slice(0, slashIdx);
      let rangeMin: number;
      let rangeMax: number;

      if (rangeStr === "*") {
        rangeMin = min;
        rangeMax = max;
      } else {
        const [lo, hi] = parseRange(rangeStr, bounds);
        rangeMin = lo;
        rangeMax = hi;
      }

      for (let v = rangeMin; v <= rangeMax; v += step) {
        values.add(v);
      }
      continue;
    }

    // range: a-b
    if (trimmed.includes("-")) {
      const [lo, hi] = parseRange(trimmed, bounds);
      for (let v = lo; v <= hi; v++) {
        values.add(v);
      }
      continue;
    }

    // single value
    const n = parseIntStrict(trimmed);
    checkBounds(n, bounds, raw);
    values.add(n);
  }

  return { values, isStar: false };
}

function parseRange(raw: string, bounds: FieldBounds): [number, number] {
  const dashIdx = raw.indexOf("-");
  if (dashIdx === -1) throw new Error(`expected range a-b, got "${raw}"`);
  const lo = parseIntStrict(raw.slice(0, dashIdx));
  const hi = parseIntStrict(raw.slice(dashIdx + 1));
  checkBounds(lo, bounds, raw);
  checkBounds(hi, bounds, raw);
  if (lo > hi) throw new Error(`range start ${lo} > end ${hi} in "${raw}"`);
  return [lo, hi];
}

function parseIntStrict(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`expected integer, got "${s}"`);
  return parseInt(s, 10);
}

function checkBounds(n: number, { min, max }: FieldBounds, raw: string): void {
  if (n < min || n > max) {
    throw new Error(`value ${n} out of range [${min}, ${max}] in "${raw}"`);
  }
}

function fullRange(min: number, max: number): Set<number> {
  const s = new Set<number>();
  for (let v = min; v <= max; v++) s.add(v);
  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a standard 5-field cron expression string.
 *
 * @throws Error if the expression is malformed or any field is out of range.
 */
export function parseCronExpression(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (minute hour dom month dow), got ${parts.length}: "${expr}"`
    );
  }

  return {
    minute:     parseField(parts[0], BOUNDS.minute),
    hour:       parseField(parts[1], BOUNDS.hour),
    dayOfMonth: parseField(parts[2], BOUNDS.dayOfMonth),
    month:      parseField(parts[3], BOUNDS.month),
    dayOfWeek:  parseField(parts[4], BOUNDS.dayOfWeek),
  };
}

/**
 * Test whether a cron expression matches a given Date (UTC, minute granularity).
 *
 * Day-of-month / day-of-week: when BOTH fields are restricted (not `*`),
 * the minute matches if either condition is satisfied (standard cron behaviour).
 *
 * @param exprOrParsed - A cron expression string, or an already-parsed CronExpression.
 * @param date         - The moment to test. Seconds and milliseconds are ignored.
 */
export function cronMatches(exprOrParsed: string | CronExpression, date: Date): boolean {
  const expr: CronExpression =
    typeof exprOrParsed === "string" ? parseCronExpression(exprOrParsed) : exprOrParsed;

  const minute     = date.getUTCMinutes();
  const hour       = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month      = date.getUTCMonth() + 1; // UTC month is 0-indexed
  const dayOfWeek  = date.getUTCDay();

  if (!expr.minute.values.has(minute))  return false;
  if (!expr.hour.values.has(hour))      return false;
  if (!expr.month.values.has(month))    return false;

  // DoM / DoW OR logic: if both are restricted, match either; if one is *,
  // only the restricted field must match.
  const domRestricted = !expr.dayOfMonth.isStar;
  const dowRestricted = !expr.dayOfWeek.isStar;

  if (domRestricted && dowRestricted) {
    return expr.dayOfMonth.values.has(dayOfMonth) || expr.dayOfWeek.values.has(dayOfWeek);
  }
  if (domRestricted) return expr.dayOfMonth.values.has(dayOfMonth);
  if (dowRestricted) return expr.dayOfWeek.values.has(dayOfWeek);
  // both are * — always match on day
  return true;
}

// re-export field names for tests
export { FIELD_NAMES };
