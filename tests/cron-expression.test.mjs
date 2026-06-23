import assert from "node:assert/strict";
import test from "node:test";

import { parseCronExpression, cronMatches } from "../dist/runtime/cron/expression.js";

// Helpers — all dates constructed in UTC for consistency
// new Date(Date.UTC(year, month0, day, hour, minute))

const d = (year, month1, day, hour, minute) =>
  new Date(Date.UTC(year, month1 - 1, day, hour, minute));

// ---------------------------------------------------------------------------
// parseCronExpression — structural / error tests
// ---------------------------------------------------------------------------

test("parseCronExpression: accepts a valid 5-field expression", () => {
  const expr = parseCronExpression("0 9 * * 1");
  assert.ok(expr.minute.values.has(0));
  assert.ok(expr.hour.values.has(9));
  assert.ok(expr.dayOfWeek.values.has(1));
  assert.equal(expr.dayOfMonth.isStar, true);
  assert.equal(expr.month.isStar, true);
});

test("parseCronExpression: throws on too few fields", () => {
  assert.throws(() => parseCronExpression("* * * *"), /5 fields/);
});

test("parseCronExpression: throws on too many fields", () => {
  assert.throws(() => parseCronExpression("* * * * * *"), /5 fields/);
});

test("parseCronExpression: throws on empty string", () => {
  assert.throws(() => parseCronExpression(""), /5 fields/);
});

test("parseCronExpression: throws on out-of-range minute", () => {
  assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
});

test("parseCronExpression: throws on out-of-range hour", () => {
  assert.throws(() => parseCronExpression("0 24 * * *"), /out of range/);
});

test("parseCronExpression: throws on out-of-range month", () => {
  assert.throws(() => parseCronExpression("0 0 1 13 *"), /out of range/);
});

test("parseCronExpression: throws on out-of-range day-of-week", () => {
  assert.throws(() => parseCronExpression("0 0 * * 7"), /out of range/);
});

test("parseCronExpression: throws on invalid step (0)", () => {
  assert.throws(() => parseCronExpression("*/0 * * * *"), /step must be >= 1/);
});

test("parseCronExpression: throws on non-integer field", () => {
  assert.throws(() => parseCronExpression("foo * * * *"), /expected integer/);
});

test("parseCronExpression: throws on reversed range", () => {
  assert.throws(() => parseCronExpression("30-10 * * * *"), /range start .* > end/);
});

// ---------------------------------------------------------------------------
// Field expansion — all five syntaxes
// ---------------------------------------------------------------------------

test("* expands to all allowed values for minute", () => {
  const expr = parseCronExpression("* * * * *");
  assert.equal(expr.minute.isStar, true);
  for (let i = 0; i <= 59; i++) assert.ok(expr.minute.values.has(i), `missing ${i}`);
});

test("*/15 expands to 0,15,30,45 for minute", () => {
  const expr = parseCronExpression("*/15 * * * *");
  assert.deepEqual([...expr.minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.equal(expr.minute.isStar, false);
});

test("0-30/10 expands to 0,10,20,30 for minute", () => {
  const expr = parseCronExpression("0-30/10 * * * *");
  assert.deepEqual([...expr.minute.values].sort((a, b) => a - b), [0, 10, 20, 30]);
});

test("list 1,2,3 expands correctly for hour", () => {
  const expr = parseCronExpression("* 1,2,3 * * *");
  assert.deepEqual([...expr.hour.values].sort((a, b) => a - b), [1, 2, 3]);
});

test("range 9-17 expands correctly for hour", () => {
  const expr = parseCronExpression("* 9-17 * * *");
  for (let h = 9; h <= 17; h++) assert.ok(expr.hour.values.has(h));
  assert.ok(!expr.hour.values.has(8));
  assert.ok(!expr.hour.values.has(18));
});

test("mixed list+range for day-of-month", () => {
  const expr = parseCronExpression("* * 1,15-17 * *");
  assert.ok(expr.dayOfMonth.values.has(1));
  assert.ok(expr.dayOfMonth.values.has(15));
  assert.ok(expr.dayOfMonth.values.has(16));
  assert.ok(expr.dayOfMonth.values.has(17));
  assert.ok(!expr.dayOfMonth.values.has(2));
});

// ---------------------------------------------------------------------------
// cronMatches — basic field matching
// ---------------------------------------------------------------------------

test("* * * * * matches any date", () => {
  assert.ok(cronMatches("* * * * *", d(2026, 1, 1, 0, 0)));
  assert.ok(cronMatches("* * * * *", d(2026, 6, 15, 12, 30)));
  assert.ok(cronMatches("* * * * *", d(2026, 12, 31, 23, 59)));
});

test("specific minute and hour must match exactly", () => {
  // 2026-01-01 09:15 UTC
  const at = d(2026, 1, 1, 9, 15);
  assert.ok(cronMatches("15 9 * * *", at));
  assert.ok(!cronMatches("14 9 * * *", at));
  assert.ok(!cronMatches("15 8 * * *", at));
});

test("*/15 minute matches on :00, :15, :30, :45", () => {
  assert.ok(cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 0)));
  assert.ok(cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 15)));
  assert.ok(cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 30)));
  assert.ok(cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 45)));
  assert.ok(!cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 1)));
  assert.ok(!cronMatches("*/15 * * * *", d(2026, 1, 1, 0, 14)));
});

test("month field restricts to correct months", () => {
  // only June (6)
  assert.ok(cronMatches("0 0 1 6 *", d(2026, 6, 1, 0, 0)));
  assert.ok(!cronMatches("0 0 1 6 *", d(2026, 5, 1, 0, 0)));
  assert.ok(!cronMatches("0 0 1 6 *", d(2026, 7, 1, 0, 0)));
});

test("day-of-month field restricts correctly", () => {
  assert.ok(cronMatches("0 0 15 * *", d(2026, 1, 15, 0, 0)));
  assert.ok(!cronMatches("0 0 15 * *", d(2026, 1, 14, 0, 0)));
});

test("day-of-week field restricts correctly (0=Sunday)", () => {
  // 2026-06-21 is a Sunday — getUTCDay() === 0
  assert.ok(cronMatches("0 0 * * 0", d(2026, 6, 21, 0, 0)));
  // 2026-06-22 is a Monday — should NOT match dow=0
  assert.ok(!cronMatches("0 0 * * 0", d(2026, 6, 22, 0, 0)));
});

// ---------------------------------------------------------------------------
// DoM / DoW OR logic
// ---------------------------------------------------------------------------

test("when both DoM and DoW restricted: matches on either condition", () => {
  // 15th OR Monday (dow=1)
  // 2026-06-15 is a Monday — both match
  assert.ok(cronMatches("0 0 15 * 1", d(2026, 6, 15, 0, 0)));
  // 2026-06-16 is a Tuesday but it IS the 16th — neither 15th nor Monday → false
  assert.ok(!cronMatches("0 0 15 * 1", d(2026, 6, 16, 0, 0)));
  // 2026-06-08 is a Monday (dow=1) but NOT the 15th — OR logic → true
  assert.ok(cronMatches("0 0 15 * 1", d(2026, 6, 8, 0, 0)));
  // 2026-06-15 is the 15th but dow is checked to ensure DoM alone still wins
  assert.ok(cronMatches("0 0 15 * 1", d(2026, 6, 15, 0, 0)));
});

test("when only DoM restricted: DoW star does not restrict", () => {
  // any day-of-week on the 1st
  assert.ok(cronMatches("0 0 1 * *", d(2026, 6, 1, 0, 0)));   // Monday 2026-06-01
  assert.ok(!cronMatches("0 0 1 * *", d(2026, 6, 2, 0, 0)));
});

test("when only DoW restricted: DoM star does not restrict", () => {
  // every Wednesday (dow=3)
  // 2026-06-24 is a Wednesday
  assert.ok(cronMatches("0 0 * * 3", d(2026, 6, 24, 0, 0)));
  assert.ok(!cronMatches("0 0 * * 3", d(2026, 6, 25, 0, 0)));
});

// ---------------------------------------------------------------------------
// Accepts pre-parsed CronExpression
// ---------------------------------------------------------------------------

test("cronMatches accepts a pre-parsed CronExpression", () => {
  const expr = parseCronExpression("30 8 * * *");
  assert.ok(cronMatches(expr, d(2026, 1, 1, 8, 30)));
  assert.ok(!cronMatches(expr, d(2026, 1, 1, 8, 31)));
});
