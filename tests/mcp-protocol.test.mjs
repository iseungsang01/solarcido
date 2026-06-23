import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_SERVER_PROTOCOL_VERSION,
  makeRequest,
  defaultInitializeParams,
  encodeContentLengthFrame,
  decodeContentLengthFrame,
  encodeLineFrame,
  decodeLineFrame,
  encodeFrame,
  decodeFrame,
  FramingError,
} from "../dist/runtime/mcp/protocol.js";

// ---------------------------------------------------------------------------
// envelope helpers
// ---------------------------------------------------------------------------

test("makeRequest builds a 2.0 envelope and omits undefined params", () => {
  const noParams = makeRequest(1, "ping");
  assert.deepEqual(noParams, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.ok(!("params" in noParams));

  const withParams = makeRequest("abc", "tools/call", { name: "echo" });
  assert.deepEqual(withParams, { jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "echo" } });
});

test("defaultInitializeParams advertises the protocol version and client info", () => {
  const params = defaultInitializeParams();
  assert.equal(params.protocolVersion, MCP_SERVER_PROTOCOL_VERSION);
  assert.deepEqual(params.capabilities, {});
  assert.equal(typeof params.clientInfo.name, "string");

  const custom = defaultInitializeParams({ name: "me", version: "9.9" });
  assert.deepEqual(custom.clientInfo, { name: "me", version: "9.9" });
});

// ---------------------------------------------------------------------------
// Content-Length framing
// ---------------------------------------------------------------------------

test("Content-Length frame round-trips a message", () => {
  const message = { jsonrpc: "2.0", id: 7, result: { ok: true } };
  const frame = encodeContentLengthFrame(message);
  const header = frame.toString("utf8").split("\r\n\r\n")[0];
  assert.match(header, /^Content-Length: \d+$/);

  const decoded = decodeContentLengthFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(decoded.message, message);
  assert.equal(decoded.bytesConsumed, frame.length);
});

test("decodeContentLengthFrame returns undefined for an incomplete frame", () => {
  const frame = encodeContentLengthFrame({ a: 1 });
  // Header present but body truncated.
  const partial = frame.subarray(0, frame.length - 1);
  assert.equal(decodeContentLengthFrame(partial), undefined);
  // No header terminator yet.
  assert.equal(decodeContentLengthFrame(Buffer.from("Content-Length: 5\r\n")), undefined);
});

test("decodeContentLengthFrame accepts a lowercase header name", () => {
  const body = Buffer.from(JSON.stringify({ hi: 1 }), "utf8");
  const frame = Buffer.concat([Buffer.from(`content-length: ${body.length}\r\n\r\n`), body]);
  const decoded = decodeContentLengthFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(decoded.message, { hi: 1 });
});

test("decodeContentLengthFrame throws on a missing Content-Length header", () => {
  const frame = Buffer.from("X-Other: 1\r\n\r\n{}");
  assert.throws(() => decodeContentLengthFrame(frame), FramingError);
});

test("decodeContentLengthFrame consumes only the first of two concatenated frames", () => {
  const first = encodeContentLengthFrame({ id: 1 });
  const second = encodeContentLengthFrame({ id: 2 });
  const stream = Buffer.concat([first, second]);

  const a = decodeContentLengthFrame(stream);
  assert.ok(a);
  assert.deepEqual(a.message, { id: 1 });
  assert.equal(a.bytesConsumed, first.length);

  const b = decodeContentLengthFrame(stream.subarray(a.bytesConsumed));
  assert.ok(b);
  assert.deepEqual(b.message, { id: 2 });
});

// ---------------------------------------------------------------------------
// line framing
// ---------------------------------------------------------------------------

test("line frame round-trips a message", () => {
  const message = { jsonrpc: "2.0", id: 3, method: "ping" };
  const frame = encodeLineFrame(message);
  assert.ok(frame.toString("utf8").endsWith("\n"));
  const decoded = decodeLineFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(decoded.message, message);
  assert.equal(decoded.bytesConsumed, frame.length);
});

test("decodeLineFrame returns undefined without a newline and skips blank lines", () => {
  assert.equal(decodeLineFrame(Buffer.from('{"a":1}')), undefined);
  const blank = decodeLineFrame(Buffer.from("\n{}"));
  assert.ok(blank);
  assert.equal(blank.message, undefined);
  assert.equal(blank.bytesConsumed, 1);
});

test("decodeLineFrame throws on an invalid JSON line", () => {
  assert.throws(() => decodeLineFrame(Buffer.from("not json\n")), FramingError);
});

// ---------------------------------------------------------------------------
// mode-dispatching wrappers
// ---------------------------------------------------------------------------

test("encodeFrame/decodeFrame honour the framing mode", () => {
  const message = { id: 42 };

  const cl = encodeFrame(message, "content-length");
  assert.match(cl.toString("utf8"), /^Content-Length:/);
  assert.deepEqual(decodeFrame(cl, "content-length").message, message);

  const line = encodeFrame(message, "line");
  assert.ok(line.toString("utf8").endsWith("\n"));
  assert.deepEqual(decodeFrame(line, "line").message, message);

  // Default mode is content-length.
  assert.match(encodeFrame(message).toString("utf8"), /^Content-Length:/);
});
