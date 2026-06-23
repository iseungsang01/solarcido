// Plugin lifecycle state machine: Unconfigured → Validated → Starting → Healthy/Degraded/Failed.
// Ported from claw-rust/crates/runtime/src/plugin_lifecycle.rs.
// Provider-neutral: no vendor-specific imports.

// ---------------------------------------------------------------------------
// ServerStatus
// ---------------------------------------------------------------------------

export type ServerStatus = "healthy" | "degraded" | "failed";

// ---------------------------------------------------------------------------
// ServerHealth
// ---------------------------------------------------------------------------

export type ServerHealth = {
  serverName: string;
  status: ServerStatus;
  /** Tool/resource names exposed by this server. */
  capabilities: string[];
  lastError: string | undefined;
};

export function makeServerHealth(
  serverName: string,
  status: ServerStatus,
  capabilities: string[],
  lastError?: string,
): ServerHealth {
  return { serverName, status, capabilities, lastError };
}

// ---------------------------------------------------------------------------
// PluginState — discriminated union
// ---------------------------------------------------------------------------

export type PluginState =
  | { state: "unconfigured" }
  | { state: "validated" }
  | { state: "starting" }
  | { state: "healthy" }
  | { state: "degraded"; healthyServers: string[]; failedServers: ServerHealth[] }
  | { state: "failed"; reason: string }
  | { state: "shutting_down" }
  | { state: "stopped" };

/** Derive a PluginState from a list of server health snapshots. */
export function pluginStateFromServers(servers: ServerHealth[]): PluginState {
  if (servers.length === 0) {
    return { state: "failed", reason: "no servers available" };
  }

  const healthyServers = servers
    .filter((s) => s.status !== "failed")
    .map((s) => s.serverName);

  const failedServers = servers.filter((s) => s.status === "failed");
  const hasDegraded = servers.some((s) => s.status === "degraded");

  if (failedServers.length === 0 && !hasDegraded) {
    return { state: "healthy" };
  }

  if (healthyServers.length === 0) {
    return { state: "failed", reason: `all ${failedServers.length} servers failed` };
  }

  return { state: "degraded", healthyServers, failedServers };
}

/** Human-readable label for a PluginState. */
export function pluginStateLabel(state: PluginState): string {
  switch (state.state) {
    case "unconfigured":
      return "unconfigured";
    case "validated":
      return "validated";
    case "starting":
      return "starting";
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "failed":
      return "failed";
    case "shutting_down":
      return "shutting_down";
    case "stopped":
      return "stopped";
  }
}

// ---------------------------------------------------------------------------
// ToolInfo / ResourceInfo — minimal discovery types
// ---------------------------------------------------------------------------

export type ToolInfo = {
  name: string;
  description: string | undefined;
  inputSchema: unknown;
};

export type ResourceInfo = {
  uri: string;
  name: string;
  description: string | undefined;
  mimeType: string | undefined;
};

// ---------------------------------------------------------------------------
// DiscoveryResult
// ---------------------------------------------------------------------------

export type DiscoveryResult = {
  tools: ToolInfo[];
  resources: ResourceInfo[];
  /** True when discovery is incomplete (some servers failed). */
  partial: boolean;
};

// ---------------------------------------------------------------------------
// DegradedMode
// ---------------------------------------------------------------------------

export type DegradedMode = {
  availableTools: string[];
  unavailableTools: string[];
  reason: string;
};

export function makeDegradedMode(
  availableTools: string[],
  unavailableTools: string[],
  reason: string,
): DegradedMode {
  return { availableTools, unavailableTools, reason };
}

// ---------------------------------------------------------------------------
// PluginHealthcheck
// ---------------------------------------------------------------------------

export type PluginHealthcheck = {
  pluginName: string;
  state: PluginState;
  servers: ServerHealth[];
  lastCheck: number;
};

/** Build a PluginHealthcheck from the current server list and a timestamp. */
export function makePluginHealthcheck(
  pluginName: string,
  servers: ServerHealth[],
  nowSecs: number,
): PluginHealthcheck {
  return {
    pluginName,
    state: pluginStateFromServers(servers),
    servers,
    lastCheck: nowSecs,
  };
}

/**
 * Derive a DegradedMode from a healthcheck and a discovery result.
 * Returns undefined when the plugin is not in degraded state.
 */
export function degradedMode(
  healthcheck: PluginHealthcheck,
  discovery: DiscoveryResult,
): DegradedMode | undefined {
  if (healthcheck.state.state !== "degraded") return undefined;
  const { healthyServers, failedServers } = healthcheck.state;
  return {
    availableTools: discovery.tools.map((t) => t.name),
    unavailableTools: failedServers.flatMap((s) => s.capabilities),
    reason: `${healthyServers.length} servers healthy, ${failedServers.length} servers failed`,
  };
}

// ---------------------------------------------------------------------------
// PluginLifecycleEvent
// ---------------------------------------------------------------------------

export type PluginLifecycleEvent =
  | "config_validated"
  | "startup_healthy"
  | "startup_degraded"
  | "startup_failed"
  | "shutdown";

export function pluginLifecycleEventLabel(event: PluginLifecycleEvent): string {
  return event;
}

// ---------------------------------------------------------------------------
// PluginLifecycle interface
// ---------------------------------------------------------------------------

/**
 * Interface that a plugin must implement to participate in the lifecycle.
 * Implementations are expected to be stateful; validateConfig/healthcheck/discover
 * are read-only queries and shutdown is the single mutating operation.
 */
export interface PluginLifecycle {
  validateConfig(config: Record<string, unknown>): Result<void, string>;
  healthcheck(nowSecs: number): PluginHealthcheck;
  discover(): DiscoveryResult;
  shutdown(): Result<void, string>;
}

// ---------------------------------------------------------------------------
// Result<T, E> — lightweight tagged union to avoid throwing in lifecycle ops
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
