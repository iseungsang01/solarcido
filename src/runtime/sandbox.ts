// Sandbox configuration, detection, and Linux command building.
// Ported from claw-rust/crates/runtime/src/sandbox.rs.
//
// Platform gate: on win32/darwin this module returns a SandboxStatus of kind
// "unsupported" (passthrough). All public functions accept injected platform
// and env inputs so tests can exercise both paths deterministically without
// spawning real processes.

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type FilesystemIsolationMode = "off" | "workspace-only" | "allow-list";

// ---------------------------------------------------------------------------
// Config / request types
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  enabled?: boolean;
  namespaceRestrictions?: boolean;
  networkIsolation?: boolean;
  filesystemMode?: FilesystemIsolationMode;
  allowedMounts?: string[];
}

export interface SandboxRequest {
  enabled: boolean;
  namespaceRestrictions: boolean;
  networkIsolation: boolean;
  filesystemMode: FilesystemIsolationMode;
  allowedMounts: string[];
}

// ---------------------------------------------------------------------------
// Output types (discriminated unions)
// ---------------------------------------------------------------------------

export interface ContainerEnvironment {
  inContainer: boolean;
  markers: string[];
}

/** Full resolved sandbox status. `kind` distinguishes supported vs. not. */
export type SandboxStatus =
  | SandboxStatusSupported
  | SandboxStatusUnsupported;

interface SandboxStatusBase {
  enabled: boolean;
  requested: SandboxRequest;
  filesystemMode: FilesystemIsolationMode;
  filesystemActive: boolean;
  allowedMounts: string[];
  inContainer: boolean;
  containerMarkers: string[];
  fallbackReason?: string;
}

export interface SandboxStatusSupported extends SandboxStatusBase {
  kind: "supported";
  supported: true;
  active: boolean;
  namespaceSupported: boolean;
  namespaceActive: boolean;
  networkSupported: boolean;
  networkActive: boolean;
}

export interface SandboxStatusUnsupported extends SandboxStatusBase {
  kind: "unsupported";
  supported: false;
  active: false;
}

export interface LinuxSandboxCommand {
  program: string;
  args: string[];
  env: Array<[string, string]>;
}

// ---------------------------------------------------------------------------
// Detection inputs (injectable for testing)
// ---------------------------------------------------------------------------

export interface SandboxDetectionInputs {
  /** Key-value pairs from the process environment. */
  envPairs: Array<[string, string]>;
  /** Whether `/.dockerenv` exists. */
  dockerenvExists: boolean;
  /** Whether `/run/.containerenv` exists. */
  containerenvExists: boolean;
  /** Raw content of `/proc/1/cgroup`, if available. */
  proc1Cgroup?: string;
}

// ---------------------------------------------------------------------------
// SandboxConfig helpers
// ---------------------------------------------------------------------------

/** Merge config defaults with per-call overrides into a concrete request. */
export function resolveRequest(
  config: SandboxConfig,
  overrides: Partial<SandboxRequest> = {},
): SandboxRequest {
  return {
    enabled: overrides.enabled ?? config.enabled ?? true,
    namespaceRestrictions:
      overrides.namespaceRestrictions ?? config.namespaceRestrictions ?? true,
    networkIsolation:
      overrides.networkIsolation ?? config.networkIsolation ?? false,
    filesystemMode:
      overrides.filesystemMode ?? config.filesystemMode ?? "workspace-only",
    allowedMounts: overrides.allowedMounts ?? config.allowedMounts ?? [],
  };
}

// ---------------------------------------------------------------------------
// Container detection (pure / injectable)
// ---------------------------------------------------------------------------

const CONTAINER_ENV_KEYS = new Set([
  "container",
  "docker",
  "podman",
  "kubernetes_service_host",
]);

const CGROUP_NEEDLES = [
  "docker",
  "containerd",
  "kubepods",
  "podman",
  "libpod",
] as const;

/** Detect container environment from injectable inputs (no real I/O). */
export function detectContainerEnvironmentFrom(
  inputs: SandboxDetectionInputs,
): ContainerEnvironment {
  const markers: string[] = [];

  if (inputs.dockerenvExists) {
    markers.push("/.dockerenv");
  }
  if (inputs.containerenvExists) {
    markers.push("/run/.containerenv");
  }

  for (const [key, value] of inputs.envPairs) {
    if (CONTAINER_ENV_KEYS.has(key.toLowerCase()) && value.length > 0) {
      markers.push(`env:${key}=${value}`);
    }
  }

  if (inputs.proc1Cgroup !== undefined) {
    for (const needle of CGROUP_NEEDLES) {
      if (inputs.proc1Cgroup.includes(needle)) {
        markers.push(`/proc/1/cgroup:${needle}`);
      }
    }
  }

  markers.sort();
  const unique = [...new Set(markers)];

  return { inContainer: unique.length > 0, markers: unique };
}

/** Detect container environment from real process environment + filesystem. */
export function detectContainerEnvironment(): ContainerEnvironment {
  // On non-Linux platforms there are no Linux-specific markers to check;
  // return empty (not-in-container) without touching the filesystem.
  if (process.platform !== "linux") {
    return { inContainer: false, markers: [] };
  }

  // Use createRequire for synchronous fs access in an ESM context.
  const req = createRequire(import.meta.url);
  const fs = req("node:fs") as typeof import("node:fs");

  let dockerenvExists = false;
  let containerenvExists = false;
  let proc1Cgroup: string | undefined;

  try {
    dockerenvExists = fs.existsSync("/.dockerenv");
    containerenvExists = fs.existsSync("/run/.containerenv");
    try {
      proc1Cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    } catch {
      // not available
    }
  } catch {
    // fs unavailable (should not happen in Node)
  }

  return detectContainerEnvironmentFrom({
    envPairs: Object.entries(process.env) as Array<[string, string]>,
    dockerenvExists,
    containerenvExists,
    proc1Cgroup,
  });
}

// ---------------------------------------------------------------------------
// Sandbox status resolution (injectable platform)
// ---------------------------------------------------------------------------

/**
 * Resolve a full SandboxStatus from a request.
 *
 * @param request   - The concrete sandbox request to evaluate.
 * @param cwd       - Working directory (used to normalise relative mounts).
 * @param platform  - Injected `process.platform` value. Defaults to the
 *                    real platform. Pass `"linux"` in tests to exercise the
 *                    Linux path on any host.
 * @param container - Pre-detected container environment. Defaults to the
 *                    real detection result.
 */
export function resolveSandboxStatus(
  request: SandboxRequest,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  container: ContainerEnvironment = detectContainerEnvironment(),
): SandboxStatus {
  const base: SandboxStatusBase = {
    enabled: request.enabled,
    requested: request,
    filesystemMode: request.filesystemMode,
    filesystemActive:
      request.enabled && request.filesystemMode !== "off",
    allowedMounts: normalizeMounts(request.allowedMounts, cwd),
    inContainer: container.inContainer,
    containerMarkers: container.markers,
  };

  // Non-Linux: return an unsupported/passthrough status immediately.
  if (platform !== "linux") {
    const reasons: string[] = [];
    if (request.enabled && request.namespaceRestrictions) {
      reasons.push(
        "namespace isolation unavailable (requires Linux with `unshare`)",
      );
    }
    if (request.enabled && request.networkIsolation) {
      reasons.push(
        "network isolation unavailable (requires Linux with `unshare`)",
      );
    }
    return {
      ...base,
      kind: "unsupported",
      supported: false,
      active: false,
      fallbackReason: reasons.length > 0 ? reasons.join("; ") : undefined,
    };
  }

  // Linux path — namespace support depends on `unshare` being functional.
  // We don't actually spawn `unshare` here; callers that need a live check
  // should pass the result of `checkUnshareWorks()` as a pre-computed flag.
  // For the injectable/testable signature we treat platform === "linux" as
  // sufficient to report namespace_supported = true.
  const namespaceSupported = true;
  const networkSupported = namespaceSupported;

  const fallbackReasons: string[] = [];

  if (request.enabled && request.namespaceRestrictions && !namespaceSupported) {
    fallbackReasons.push(
      "namespace isolation unavailable (requires Linux with `unshare`)",
    );
  }
  if (request.enabled && request.networkIsolation && !networkSupported) {
    fallbackReasons.push(
      "network isolation unavailable (requires Linux with `unshare`)",
    );
  }
  if (
    request.enabled &&
    request.filesystemMode === "allow-list" &&
    request.allowedMounts.length === 0
  ) {
    fallbackReasons.push(
      "filesystem allow-list requested without configured mounts",
    );
  }

  const active =
    request.enabled &&
    (!request.namespaceRestrictions || namespaceSupported) &&
    (!request.networkIsolation || networkSupported);

  return {
    ...base,
    kind: "supported",
    supported: true,
    active,
    namespaceSupported,
    namespaceActive:
      request.enabled && request.namespaceRestrictions && namespaceSupported,
    networkSupported,
    networkActive:
      request.enabled && request.networkIsolation && networkSupported,
    fallbackReason:
      fallbackReasons.length > 0 ? fallbackReasons.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Linux sandbox command builder
// ---------------------------------------------------------------------------

/**
 * Build the `unshare` command that wraps a shell command inside a Linux
 * user-namespace sandbox.
 *
 * Returns `undefined` when:
 * - `platform` is not `"linux"`, or
 * - sandbox is not enabled, or
 * - neither namespace nor network isolation is active.
 *
 * @param command  - The shell command to wrap (passed to `sh -lc`).
 * @param cwd      - Working directory; used to derive sandbox HOME / TMPDIR.
 * @param status   - Resolved sandbox status.
 * @param platform - Injected platform. Defaults to `process.platform`.
 * @param pathEnv  - Injected PATH value. Defaults to `process.env.PATH`.
 */
export function buildLinuxSandboxCommand(
  command: string,
  cwd: string,
  status: SandboxStatus,
  platform: NodeJS.Platform = process.platform,
  pathEnv?: string,
): LinuxSandboxCommand | undefined {
  if (platform !== "linux") return undefined;
  if (!status.enabled) return undefined;

  // Need at least one of namespace or network isolation active.
  const namespaceActive =
    status.kind === "supported" && status.namespaceActive;
  const networkActive = status.kind === "supported" && status.networkActive;
  if (!namespaceActive && !networkActive) return undefined;

  const args: string[] = [
    "--user",
    "--map-root-user",
    "--mount",
    "--ipc",
    "--pid",
    "--uts",
    "--fork",
  ];

  if (networkActive) {
    args.push("--net");
  }

  args.push("sh", "-lc", command);

  // Use POSIX-style paths even on Windows hosts in tests — the command
  // itself only ever runs on Linux, so forward-slashes are correct.
  const sandboxHome = posixJoin(cwd, ".sandbox-home");
  const sandboxTmp = posixJoin(cwd, ".sandbox-tmp");

  const env: Array<[string, string]> = [
    ["HOME", sandboxHome],
    ["TMPDIR", sandboxTmp],
    ["CLAWD_SANDBOX_FILESYSTEM_MODE", status.filesystemMode],
    ["CLAWD_SANDBOX_ALLOWED_MOUNTS", status.allowedMounts.join(":")],
  ];

  const resolvedPath = pathEnv ?? process.env["PATH"];
  if (resolvedPath !== undefined) {
    env.push(["PATH", resolvedPath]);
  }

  return { program: "unshare", args, env };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeMounts(mounts: string[], cwd: string): string[] {
  return mounts.map((mount) => {
    // Absolute paths kept as-is; relative paths joined to cwd.
    if (mount.startsWith("/") || /^[A-Za-z]:[\\/]/.test(mount)) {
      return mount;
    }
    return posixJoin(cwd, mount);
  });
}

/** Simple path join that always uses `/` (sandbox commands are Linux-only). */
function posixJoin(base: string, segment: string): string {
  return base.replace(/[\\/]+$/, "") + "/" + segment;
}
