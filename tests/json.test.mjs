import assert from "node:assert/strict";
import test from "node:test";

import { safeParse, safeStringify, renderCompact } from "../dist/runtime/json.js";

// ---------------------------------------------------------------------------
// safeParse
// ---------------------------------------------------------------------------

test("safeParse: parses a valid JSON object", () => {
  const result = safeParse('{"x":1,"y":true}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.x, 1);
    assert.equal(result.value.y, true);
  }
});

test("safeParse: parses a JSON array", () => {
  const result = safeParse("[1,2,3]");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, [1, 2, 3]);
  }
});

test("safeParse: parses a JSON string literal", () => {
  const result = safeParse('"hello"');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "hello");
  }
});

test("safeParse: parses null", () => {
  const result = safeParse("null");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, null);
  }
});

test("safeParse: returns err for invalid JSON", () => {
  const result = safeParse("{bad json}");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length > 0, "error message should be non-empty");
  }
});

test("safeParse: returns err for empty string", () => {
  const result = safeParse("");
  assert.equal(result.ok, false);
});

test("safeParse: returns err for trailing content", () => {
  const result = safeParse('{"x":1} extra');
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// safeStringify
// ---------------------------------------------------------------------------

test("safeStringify: serializes a plain object", () => {
  const result = safeStringify({ a: 1, b: "two" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, '{"a":1,"b":"two"}');
  }
});

test("safeStringify: serializes an array", () => {
  const result = safeStringify([1, false, null]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "[1,false,null]");
  }
});

test("safeStringify: respects indent parameter", () => {
  const result = safeStringify({ x: 1 }, 2);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.value.includes("\n"), "indented output should contain newlines");
  }
});

test("safeStringify: returns err for circular reference", () => {
  const obj = {};
  obj.self = obj; // circular
  const result = safeStringify(obj);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length > 0);
  }
});

// ---------------------------------------------------------------------------
// renderCompact
// ---------------------------------------------------------------------------

test("renderCompact: sorts keys alphabetically at top level", () => {
  const rendered = renderCompact({ z: 3, a: 1, m: 2 });
  assert.equal(rendered, '{"a":1,"m":2,"z":3}');
});

test("renderCompact: sorts keys recursively in nested objects", () => {
  const rendered = renderCompact({ outer: { z: "last", a: "first" } });
  assert.equal(rendered, '{"outer":{"a":"first","z":"last"}}');
});

test("renderCompact: handles arrays without sorting elements", () => {
  const rendered = renderCompact([3, 1, 2]);
  assert.equal(rendered, "[3,1,2]");
});

test("renderCompact: sorts keys inside objects nested in arrays", () => {
  const rendered = renderCompact([{ z: 1, a: 2 }]);
  assert.equal(rendered, '[{"a":2,"z":1}]');
});

test("renderCompact: handles null", () => {
  assert.equal(renderCompact(null), "null");
});

test("renderCompact: handles primitives", () => {
  assert.equal(renderCompact(42), "42");
  assert.equal(renderCompact(true), "true");
  assert.equal(renderCompact("hello"), '"hello"');
});

test("renderCompact: returns null for non-serialisable values", () => {
  const obj = {};
  obj.self = obj; // circular
  assert.equal(renderCompact(obj), null);
});

test("renderCompact: empty object", () => {
  assert.equal(renderCompact({}), "{}");
});

test("renderCompact: empty array", () => {
  assert.equal(renderCompact([]), "[]");
});

// ---------------------------------------------------------------------------
// Round-trip: safeParse -> renderCompact
// ---------------------------------------------------------------------------

test("round-trip: safeParse then renderCompact reproduces canonical form", () => {
  const source = '{"b":2,"a":1}';
  const parsed = safeParse(source);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    // renderCompact sorts keys, so a != b order becomes canonical a, b
    assert.equal(renderCompact(parsed.value), '{"a":1,"b":2}');
  }
});
