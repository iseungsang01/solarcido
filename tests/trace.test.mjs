import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryTelemetrySink,
  JsonlTelemetrySink,
  SessionTracer,
  makeAnalyticsEvent,
  makeClientIdentity,
  userAgent,
} from "../dist/telemetry/trace.js";

// ---------------------------------------------------------------------------
// Deterministic clock for tests
// ---------------------------------------------------------------------------

let _tick = 1000;
function deterministicClock() {
  return _tick++;
}

function makeTracer(sessionId = "test-session") {
  const sink = new MemoryTelemetrySink();
  const tracer = new SessionTracer(sessionId, sink, deterministicClock);
  return { sink, tracer };
}

// ---------------------------------------------------------------------------
// ClientIdentity / userAgent
// ---------------------------------------------------------------------------

test("makeClientIdentity: sets fields and defaults runtime to node", () => {
  const id = makeClientIdentity("solarcido", "0.1.0");
  assert.equal(id.appName, "solarcido");
  assert.equal(id.appVersion, "0.1.0");
  assert.equal(id.runtime, "node");
});

test("makeClientIdentity: custom runtime", () => {
  const id = makeClientIdentity("solarcido", "0.1.0", "bun");
  assert.equal(id.runtime, "bun");
});

test("userAgent: produces name/version string", () => {
  const id = makeClientIdentity("solarcido", "1.2.3");
  assert.equal(userAgent(id), "solarcido/1.2.3");
});

// ---------------------------------------------------------------------------
// MemoryTelemetrySink
// ---------------------------------------------------------------------------

test("MemoryTelemetrySink: starts empty", () => {
  const sink = new MemoryTelemetrySink();
  assert.equal(sink.events().length, 0);
});

test("MemoryTelemetrySink: records events in order", () => {
  const sink = new MemoryTelemetrySink();
  sink.record({ type: "analytics", event: makeAnalyticsEvent("ns", "a") });
  sink.record({ type: "analytics", event: makeAnalyticsEvent("ns", "b") });
  const events = sink.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "analytics");
  assert.equal(events[1].type, "analytics");
});

test("MemoryTelemetrySink: clear resets the list", () => {
  const sink = new MemoryTelemetrySink();
  sink.record({ type: "analytics", event: makeAnalyticsEvent("ns", "x") });
  sink.clear();
  assert.equal(sink.events().length, 0);
});

// ---------------------------------------------------------------------------
// JsonlTelemetrySink (injected writer — no real fs)
// ---------------------------------------------------------------------------

test("JsonlTelemetrySink: writes one JSON line per event via injected writer", () => {
  const lines = [];
  const sink = new JsonlTelemetrySink("/dev/null", (line) => lines.push(line));

  sink.record({ type: "analytics", event: makeAnalyticsEvent("cli", "turn_completed") });
  sink.record({
    type: "http-request-started",
    sessionId: "s1",
    attempt: 1,
    method: "POST",
    path: "/v1/messages",
    attributes: {},
  });

  assert.equal(lines.length, 2);
  const parsed0 = JSON.parse(lines[0]);
  assert.equal(parsed0.type, "analytics");
  assert.equal(parsed0.event.action, "turn_completed");
  const parsed1 = JSON.parse(lines[1]);
  assert.equal(parsed1.type, "http-request-started");
  assert.equal(parsed1.method, "POST");
});

test("JsonlTelemetrySink: silently drops a writer error", () => {
  const sink = new JsonlTelemetrySink("/dev/null", () => {
    throw new Error("disk full");
  });
  // Must not throw.
  sink.record({ type: "analytics", event: makeAnalyticsEvent("ns", "x") });
});

// ---------------------------------------------------------------------------
// SessionTracer
// ---------------------------------------------------------------------------

test("SessionTracer: sessionId accessor", () => {
  const { tracer } = makeTracer("my-session");
  assert.equal(tracer.sessionId, "my-session");
});

test("SessionTracer: recordHttpRequestStarted emits structured event then trace", () => {
  const { sink, tracer } = makeTracer("s1");
  tracer.recordHttpRequestStarted(1, "POST", "/v1/messages");

  const events = sink.events();
  assert.equal(events.length, 2);

  const structured = events[0];
  assert.equal(structured.type, "http-request-started");
  assert.equal(structured.sessionId, "s1");
  assert.equal(structured.attempt, 1);
  assert.equal(structured.method, "POST");
  assert.equal(structured.path, "/v1/messages");

  const trace = events[1];
  assert.equal(trace.type, "session-trace");
  assert.equal(trace.record.name, "http_request_started");
  assert.equal(trace.record.sequence, 0);
  assert.equal(trace.record.sessionId, "s1");
});

test("SessionTracer: recordHttpRequestSucceeded emits structured event then trace", () => {
  const { sink, tracer } = makeTracer("s2");
  tracer.recordHttpRequestSucceeded(1, "POST", "/v1/messages", 200, "req-id-42");

  const events = sink.events();
  assert.equal(events.length, 2);

  const structured = events[0];
  assert.equal(structured.type, "http-request-succeeded");
  assert.equal(structured.status, 200);
  assert.equal(structured.requestId, "req-id-42");

  const trace = events[1];
  assert.equal(trace.type, "session-trace");
  assert.equal(trace.record.name, "http_request_succeeded");
  assert.equal(trace.record.attributes.status, 200);
  assert.equal(trace.record.attributes.requestId, "req-id-42");
});

test("SessionTracer: recordHttpRequestSucceeded with no requestId omits field", () => {
  const { sink, tracer } = makeTracer("s3");
  tracer.recordHttpRequestSucceeded(1, "GET", "/v1/health", 204, undefined);

  const structured = sink.events()[0];
  assert.equal(structured.type, "http-request-succeeded");
  assert.equal(structured.requestId, undefined);

  const trace = sink.events()[1];
  assert.equal("requestId" in trace.record.attributes, false);
});

test("SessionTracer: recordHttpRequestFailed emits structured event then trace", () => {
  const { sink, tracer } = makeTracer("s4");
  tracer.recordHttpRequestFailed(2, "POST", "/v1/messages", "timeout", true);

  const events = sink.events();
  assert.equal(events.length, 2);

  const structured = events[0];
  assert.equal(structured.type, "http-request-failed");
  assert.equal(structured.error, "timeout");
  assert.equal(structured.retryable, true);

  const trace = events[1];
  assert.equal(trace.record.name, "http_request_failed");
  assert.equal(trace.record.attributes.retryable, true);
});

test("SessionTracer: recordAnalytics emits analytics event then trace", () => {
  const { sink, tracer } = makeTracer("s5");
  const event = makeAnalyticsEvent("cli", "prompt_sent", { model: "solar-pro3" });
  tracer.recordAnalytics(event);

  const events = sink.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "analytics");
  assert.equal(events[0].event.action, "prompt_sent");

  const trace = events[1];
  assert.equal(trace.type, "session-trace");
  assert.equal(trace.record.name, "analytics");
  assert.equal(trace.record.attributes.namespace, "cli");
  assert.equal(trace.record.attributes.action, "prompt_sent");
  assert.equal(trace.record.attributes.model, "solar-pro3");
});

test("SessionTracer: sequence counter increments monotonically across calls", () => {
  const { sink, tracer } = makeTracer("s6");
  tracer.record("span-a");
  tracer.record("span-b");
  tracer.record("span-c");

  const traces = sink.events().filter((e) => e.type === "session-trace");
  assert.equal(traces[0].record.sequence, 0);
  assert.equal(traces[1].record.sequence, 1);
  assert.equal(traces[2].record.sequence, 2);
});

test("SessionTracer: timestamps come from injected clock", () => {
  let t = 5000;
  const clock = () => t++;
  const sink = new MemoryTelemetrySink();
  const tracer = new SessionTracer("s7", sink, clock);
  tracer.record("first");
  tracer.record("second");

  const traces = sink.events().filter((e) => e.type === "session-trace");
  assert.equal(traces[0].record.timestampMs, 5000);
  assert.equal(traces[1].record.timestampMs, 5001);
});

test("SessionTracer: mixed sequence across event types preserves global order", () => {
  const { sink, tracer } = makeTracer("s8");
  // Each recording method emits: 1 structured event + 1 session-trace.
  tracer.recordHttpRequestStarted(1, "POST", "/a");
  tracer.recordAnalytics(makeAnalyticsEvent("ns", "x"));

  const traces = sink.events().filter((e) => e.type === "session-trace");
  assert.equal(traces.length, 2);
  assert.equal(traces[0].record.sequence, 0);
  assert.equal(traces[1].record.sequence, 1);
});
