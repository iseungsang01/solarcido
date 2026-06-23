/**
 * MCP lifecycle phase model + transition validator + error surfacing (pure).
 *
 * Ported from claw-rust crates/runtime/src/mcp_lifecycle_hardened.rs. Drives a
 * deterministic state machine over the well-known MCP startup/teardown phases,
 * validating transitions and recording structured error/timeout surfaces so a
 * degraded-startup report can be assembled later.
 *
 * Phases are modelled as a string-literal discriminated union (the serde
 * `snake_case` names from the Rust enum), so the `Display` form and the
 * serialized form coincide.
 */

/** Ordered MCP lifecycle phases (snake_case names match the wire form). */
export type McpLifecyclePhase =
  | "config_load"
  | "server_registration"
  | "spawn_connect"
  | "initialize_handshake"
  | "tool_discovery"
  | "resource_discovery"
  | "ready"
  | "invocation"
  | "error_surfacing"
  | "shutdown"
  | "cleanup";

/** All phases in canonical order. */
export const MCP_LIFECYCLE_PHASES: readonly McpLifecyclePhase[] = [
  "config_load",
  "server_registration",
  "spawn_connect",
  "initialize_handshake",
  "tool_discovery",
  "resource_discovery",
  "ready",
  "invocation",
  "error_surfacing",
  "shutdown",
  "cleanup",
];

/** A structured, surfaceable lifecycle error. */
export type McpErrorSurface = {
  phase: McpLifecyclePhase;
  serverName?: string;
  message: string;
  context: Record<string, string>;
  recoverable: boolean;
  /** Unix seconds when the surface was created. */
  timestamp: number;
};

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Construct an {@link McpErrorSurface}, stamping the current time. */
export function makeErrorSurface(
  phase: McpLifecyclePhase,
  message: string,
  options: { serverName?: string; context?: Record<string, string>; recoverable?: boolean } = {},
): McpErrorSurface {
  return {
    phase,
    serverName: options.serverName,
    message,
    context: options.context ?? {},
    recoverable: options.recoverable ?? false,
    timestamp: nowSecs(),
  };
}

/** Render an error surface the way the Rust `Display` impl does. */
export function renderErrorSurface(error: McpErrorSurface): string {
  let out = `MCP lifecycle error during ${error.phase}: ${error.message}`;
  if (error.serverName) out += ` (server: ${error.serverName})`;
  if (Object.keys(error.context).length > 0) out += ` with context ${JSON.stringify(error.context)}`;
  if (error.recoverable) out += " [recoverable]";
  return out;
}

/** Outcome of running a phase: success, structured failure, or timeout. */
export type McpPhaseResult =
  | { kind: "success"; phase: McpLifecyclePhase; durationMs: number }
  | { kind: "failure"; phase: McpLifecyclePhase; error: McpErrorSurface }
  | { kind: "timeout"; phase: McpLifecyclePhase; waitedMs: number; error: McpErrorSurface };

/** A server that failed during a lifecycle phase. */
export type McpFailedServer = {
  serverName: string;
  phase: McpLifecyclePhase;
  error: McpErrorSurface;
};

/** Degraded-startup report: which servers/tools survived and which did not. */
export type McpDegradedReport = {
  workingServers: string[];
  failedServers: McpFailedServer[];
  availableTools: string[];
  missingTools: string[];
};

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build a degraded report, computing `missingTools = expected − available`. */
export function buildDegradedReport(
  workingServers: string[],
  failedServers: McpFailedServer[],
  availableTools: string[],
  expectedTools: string[],
): McpDegradedReport {
  const working = dedupeSorted(workingServers);
  const available = dedupeSorted(availableTools);
  const availableSet = new Set(available);
  const missingTools = dedupeSorted(expectedTools).filter((tool) => !availableSet.has(tool));
  return { workingServers: working, failedServers, availableTools: available, missingTools };
}

/**
 * Allowed phase transitions. Mirrors the Rust `validate_phase_transition`
 * control-flow exactly, including the catch-all rules that let any non-terminal
 * phase fall into `shutdown`/`error_surfacing`.
 */
export function validatePhaseTransition(from: McpLifecyclePhase, to: McpLifecyclePhase): boolean {
  const explicit: ReadonlySet<string> = new Set([
    "config_load->server_registration",
    "server_registration->spawn_connect",
    "spawn_connect->initialize_handshake",
    "initialize_handshake->tool_discovery",
    "tool_discovery->resource_discovery",
    "tool_discovery->ready",
    "resource_discovery->ready",
    "ready->invocation",
    "invocation->ready",
    "error_surfacing->ready",
    "error_surfacing->shutdown",
    "shutdown->cleanup",
  ]);
  if (explicit.has(`${from}->${to}`)) return true;
  if (to === "shutdown") return from !== "cleanup";
  if (to === "error_surfacing") return from !== "cleanup" && from !== "shutdown";
  return false;
}

/** Accumulated lifecycle state: current phase, per-phase errors, results. */
export type McpLifecycleState = {
  currentPhase?: McpLifecyclePhase;
  phaseErrors: Map<McpLifecyclePhase, McpErrorSurface[]>;
  phaseTimestamps: Map<McpLifecyclePhase, number>;
  phaseResults: McpPhaseResult[];
};

/**
 * Stateful validator that walks the lifecycle, enforcing legal transitions and
 * recording structured failures/timeouts. A direct port of the Rust
 * `McpLifecycleValidator`.
 */
export class McpLifecycleValidator {
  private readonly state: McpLifecycleState = {
    currentPhase: undefined,
    phaseErrors: new Map(),
    phaseTimestamps: new Map(),
    phaseResults: [],
  };

  /** Current phase, or `undefined` before the first `runPhase`. */
  currentPhase(): McpLifecyclePhase | undefined {
    return this.state.currentPhase;
  }

  /** Recorded error surfaces for a given phase. */
  errorsForPhase(phase: McpLifecyclePhase): McpErrorSurface[] {
    return this.state.phaseErrors.get(phase) ?? [];
  }

  /** All recorded phase results, in order. */
  results(): McpPhaseResult[] {
    return this.state.phaseResults;
  }

  /** Unix-seconds timestamp the phase was last entered, if ever. */
  phaseTimestamp(phase: McpLifecyclePhase): number | undefined {
    return this.state.phaseTimestamps.get(phase);
  }

  private canResumeAfterError(): boolean {
    const last = this.state.phaseResults[this.state.phaseResults.length - 1];
    if (last && (last.kind === "failure" || last.kind === "timeout")) {
      return last.error.recoverable;
    }
    return false;
  }

  private recordPhase(phase: McpLifecyclePhase): void {
    this.state.currentPhase = phase;
    this.state.phaseTimestamps.set(phase, nowSecs());
  }

  private recordError(error: McpErrorSurface): void {
    const list = this.state.phaseErrors.get(error.phase) ?? [];
    list.push(error);
    this.state.phaseErrors.set(error.phase, list);
  }

  /**
   * Attempt to enter `phase`. Returns a success result when the transition is
   * legal, otherwise records and returns a structured failure (moving the
   * machine into `error_surfacing`).
   */
  runPhase(phase: McpLifecyclePhase): McpPhaseResult {
    const started = Date.now();
    const current = this.state.currentPhase;

    if (current !== undefined) {
      if (current === "error_surfacing" && phase === "ready" && !this.canResumeAfterError()) {
        return this.recordFailure(
          makeErrorSurface(phase, "cannot return to ready after a non-recoverable MCP lifecycle failure", {
            context: { from: current, to: phase },
          }),
        );
      }
      if (!validatePhaseTransition(current, phase)) {
        return this.recordFailure(
          makeErrorSurface(phase, `invalid MCP lifecycle transition from ${current} to ${phase}`, {
            context: { from: current, to: phase },
          }),
        );
      }
    } else if (phase !== "config_load") {
      return this.recordFailure(
        makeErrorSurface(phase, `invalid initial MCP lifecycle phase ${phase}`, {
          context: { phase },
        }),
      );
    }

    this.recordPhase(phase);
    const result: McpPhaseResult = { kind: "success", phase, durationMs: Date.now() - started };
    this.state.phaseResults.push(result);
    return result;
  }

  /** Record an external failure, moving the machine into `error_surfacing`. */
  recordFailure(error: McpErrorSurface): McpPhaseResult {
    const phase = error.phase;
    this.recordError(error);
    this.recordPhase("error_surfacing");
    const result: McpPhaseResult = { kind: "failure", phase, error };
    this.state.phaseResults.push(result);
    return result;
  }

  /** Record a timeout for `phase`, marked recoverable, into `error_surfacing`. */
  recordTimeout(
    phase: McpLifecyclePhase,
    waitedMs: number,
    options: { serverName?: string; context?: Record<string, string> } = {},
  ): McpPhaseResult {
    const context = { ...(options.context ?? {}), waited_ms: String(waitedMs) };
    const error = makeErrorSurface(phase, `MCP lifecycle phase ${phase} timed out after ${waitedMs} ms`, {
      serverName: options.serverName,
      context,
      recoverable: true,
    });
    this.recordError(error);
    this.recordPhase("error_surfacing");
    const result: McpPhaseResult = { kind: "timeout", phase, waitedMs, error };
    this.state.phaseResults.push(result);
    return result;
  }
}
