// Session tracing and telemetry event plumbing for Solarcido.
// Ported from claw-rust/crates/telemetry/src/lib.rs.
// Provider-neutral: Anthropic-specific request profiles are intentionally omitted.
// Pure module: no hard fs dependency — the JSONL sink accepts an injectable writer
// so the unit test can use the memory sink without touching the filesystem.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

/** Identifies the app and runtime that emitted a telemetry event. */
export type ClientIdentity = {
  appName: string;
  appVersion: string;
  runtime: string;
};

/** Build a ClientIdentity for Solarcido. */
export function makeClientIdentity(
  appName: string,
  appVersion: string,
  runtime = "node",
): ClientIdentity {
  return { appName, appVersion, runtime };
}

/** Produce a User-Agent string, e.g. "solarcido/0.1.0". */
export function userAgent(identity: ClientIdentity): string {
  return `${identity.appName}/${identity.appVersion}`;
}

// ---------------------------------------------------------------------------
// Analytics event
// ---------------------------------------------------------------------------

/** A single analytics action with optional string-keyed properties. */
export type AnalyticsEvent = {
  namespace: string;
  action: string;
  properties: Record<string, unknown>;
};

export function makeAnalyticsEvent(
  namespace: string,
  action: string,
  properties: Record<string, unknown> = {},
): AnalyticsEvent {
  return { namespace, action, properties };
}

// ---------------------------------------------------------------------------
// Session-trace record
// ---------------------------------------------------------------------------

/** A structured span record attached to a session. */
export type SessionTraceRecord = {
  sessionId: string;
  sequence: number;
  name: string;
  timestampMs: number;
  attributes: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// TelemetryEvent discriminated union
// ---------------------------------------------------------------------------

export type TelemetryEvent =
  | {
      type: "http-request-started";
      sessionId: string;
      attempt: number;
      method: string;
      path: string;
      attributes: Record<string, unknown>;
    }
  | {
      type: "http-request-succeeded";
      sessionId: string;
      attempt: number;
      method: string;
      path: string;
      status: number;
      requestId: string | undefined;
      attributes: Record<string, unknown>;
    }
  | {
      type: "http-request-failed";
      sessionId: string;
      attempt: number;
      method: string;
      path: string;
      error: string;
      retryable: boolean;
      attributes: Record<string, unknown>;
    }
  | { type: "analytics"; event: AnalyticsEvent }
  | { type: "session-trace"; record: SessionTraceRecord };

// ---------------------------------------------------------------------------
// Telemetry sink interface + implementations
// ---------------------------------------------------------------------------

/** Accepts telemetry events without a return value. */
export interface TelemetrySink {
  record(event: TelemetryEvent): void;
}

/** In-memory sink — accumulates events; useful for tests. */
export class MemoryTelemetrySink implements TelemetrySink {
  private readonly _events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this._events.push(event);
  }

  /** Return a snapshot of recorded events. */
  events(): readonly TelemetryEvent[] {
    return this._events;
  }

  /** Clear all recorded events. */
  clear(): void {
    this._events.length = 0;
  }
}

/** A synchronous line-append writer used by JsonlTelemetrySink. */
export type LineWriter = (line: string) => void;

/**
 * JSONL sink — writes one JSON line per event to a file (append mode).
 *
 * Pass an injectable `writer` to avoid real fs I/O in tests; omit it and
 * provide a `path` to get the default filesystem-backed behaviour.
 */
export class JsonlTelemetrySink implements TelemetrySink {
  private readonly _write: LineWriter;
  readonly path: string;

  constructor(filePath: string, writer?: LineWriter) {
    this.path = filePath;
    if (writer) {
      this._write = writer;
    } else {
      // Ensure parent directory exists before first write.
      mkdirSync(dirname(filePath), { recursive: true });
      this._write = (line: string) => appendFileSync(filePath, line + "\n", "utf8");
    }
  }

  record(event: TelemetryEvent): void {
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch {
      return; // drop un-serialisable events silently
    }
    try {
      this._write(line);
    } catch {
      // I/O errors are non-fatal — telemetry must not crash the app.
    }
  }
}

// ---------------------------------------------------------------------------
// Clock abstraction (injectable for determinism)
// ---------------------------------------------------------------------------

/** A function that returns the current time in milliseconds. */
export type Clock = () => number;

// ---------------------------------------------------------------------------
// SessionTracer
// ---------------------------------------------------------------------------

/**
 * Attaches a session ID and monotonic sequence counter to every event
 * and fans them out to the underlying TelemetrySink.
 *
 * Inject a `clock` in tests so timestamps are deterministic.
 */
export class SessionTracer {
  private readonly _sessionId: string;
  private _sequence = 0;
  private readonly _sink: TelemetrySink;
  private readonly _clock: Clock;

  constructor(sessionId: string, sink: TelemetrySink, clock: Clock = () => Date.now()) {
    this._sessionId = sessionId;
    this._sink = sink;
    this._clock = clock;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _nextSeq(): number {
    return this._sequence++;
  }

  private _spanRecord(name: string, attributes: Record<string, unknown>): SessionTraceRecord {
    return {
      sessionId: this._sessionId,
      sequence: this._nextSeq(),
      name,
      timestampMs: this._clock(),
      attributes,
    };
  }

  private _emitTrace(name: string, attributes: Record<string, unknown>): void {
    this._sink.record({ type: "session-trace", record: this._spanRecord(name, attributes) });
  }

  // -------------------------------------------------------------------------
  // Public recording methods
  // -------------------------------------------------------------------------

  recordHttpRequestStarted(
    attempt: number,
    method: string,
    path: string,
    attributes: Record<string, unknown> = {},
  ): void {
    this._sink.record({
      type: "http-request-started",
      sessionId: this._sessionId,
      attempt,
      method,
      path,
      attributes,
    });
    this._emitTrace("http_request_started", { method, path, attempt, ...attributes });
  }

  recordHttpRequestSucceeded(
    attempt: number,
    method: string,
    path: string,
    status: number,
    requestId: string | undefined,
    attributes: Record<string, unknown> = {},
  ): void {
    this._sink.record({
      type: "http-request-succeeded",
      sessionId: this._sessionId,
      attempt,
      method,
      path,
      status,
      requestId,
      attributes,
    });
    this._emitTrace("http_request_succeeded", {
      method,
      path,
      attempt,
      status,
      ...(requestId !== undefined ? { requestId } : {}),
      ...attributes,
    });
  }

  recordHttpRequestFailed(
    attempt: number,
    method: string,
    path: string,
    error: string,
    retryable: boolean,
    attributes: Record<string, unknown> = {},
  ): void {
    this._sink.record({
      type: "http-request-failed",
      sessionId: this._sessionId,
      attempt,
      method,
      path,
      error,
      retryable,
      attributes,
    });
    this._emitTrace("http_request_failed", { method, path, attempt, error, retryable, ...attributes });
  }

  recordAnalytics(event: AnalyticsEvent): void {
    this._sink.record({ type: "analytics", event });
    this._emitTrace("analytics", {
      namespace: event.namespace,
      action: event.action,
      ...event.properties,
    });
  }

  /** Record a named trace span with arbitrary attributes. */
  record(name: string, attributes: Record<string, unknown> = {}): void {
    this._emitTrace(name, attributes);
  }
}
