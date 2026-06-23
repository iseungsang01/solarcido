import test from "node:test";
import assert from "node:assert/strict";

import { classifyApiError, isRetryable, formatClassifiedError } from "../dist/api/errors.js";

test("classifies 429 as rate-limit (retryable)", () => {
  const c = classifyApiError({ status: 429, message: "Rate limited" });
  assert.equal(c.kind, "rate-limit");
  assert.equal(isRetryable(c), true);
});

test("classifies 401 and 403 as auth (not retryable)", () => {
  assert.equal(classifyApiError({ status: 401, message: "Unauthorized" }).kind, "auth");
  assert.equal(classifyApiError({ status: 403, message: "Forbidden" }).kind, "auth");
  assert.equal(isRetryable(classifyApiError({ status: 401, message: "x" })), false);
});

test("classifies context-length 400 as context-window (not retryable)", () => {
  const c = classifyApiError({
    status: 400,
    message: "This model's maximum context length is 200000 tokens, but your request used 230000.",
  });
  assert.equal(c.kind, "context-window");
  assert.equal(isRetryable(c), false);
});

test("classifies 5xx as retryable", () => {
  const c = classifyApiError({ status: 503, message: "Service Unavailable" });
  assert.equal(c.kind, "retryable");
  assert.equal(isRetryable(c), true);
});

test("classifies timeout as timeout (retryable)", () => {
  const c = classifyApiError({ name: "APIConnectionTimeoutError", message: "Request timed out" });
  assert.equal(c.kind, "timeout");
  assert.equal(isRetryable(c), true);
});

test("classifies connection reset as retryable", () => {
  assert.equal(classifyApiError({ code: "ECONNRESET", message: "socket hang up" }).kind, "retryable");
});

test("classifies missing api key as auth", () => {
  assert.equal(classifyApiError(new Error("UPSTAGE_API_KEY is required.")).kind, "auth");
});

test("classifies malformed json as json", () => {
  let thrown;
  try {
    JSON.parse("{not json");
  } catch (err) {
    thrown = err;
  }
  assert.equal(classifyApiError(thrown).kind, "json");
});

test("unknown error falls back to unknown (not retryable)", () => {
  const c = classifyApiError(new Error("boom"));
  assert.equal(c.kind, "unknown");
  assert.equal(isRetryable(c), false);
});

test("preserves status, code, and requestId", () => {
  const c = classifyApiError({ status: 429, code: "rate_limit_exceeded", request_id: "req_1", message: "x" });
  assert.equal(c.status, 429);
  assert.equal(c.code, "rate_limit_exceeded");
  assert.equal(c.requestId, "req_1");
});

test("formatClassifiedError is a compact one-liner", () => {
  const line = formatClassifiedError(classifyApiError({ status: 429, request_id: "req_9", message: "slow down" }));
  assert.match(line, /^\[rate-limit\] \(429\) slow down \[trace req_9\]$/);
});

test("never throws on odd inputs", () => {
  assert.equal(classifyApiError(null).kind, "unknown");
  assert.equal(classifyApiError(undefined).kind, "unknown");
  assert.equal(classifyApiError(42).kind, "unknown");
});
