// Remote session context and upstream proxy bootstrap/state.
// Ported from claw-rust/crates/runtime/src/remote.rs.
//
// Key design differences from the Rust original:
// - DEFAULT_REMOTE_BASE_URL and NO_PROXY_HOSTS are removed as hard-coded
//   constants. The base URL and no-proxy list are configurable inputs —
//   no anthropic.com-specific defaults appear here.
// - All I/O (token file reads) uses Node's `node:fs` module synchronously
//   to match the Rust original's synchronous character.
// - fromEnv / fromEnvMap accept an injectable env map for deterministic tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env keys that carry upstream proxy configuration into subprocesses. */
export const UPSTREAM_PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

export type UpstreamProxyEnvKey = (typeof UPSTREAM_PROXY_ENV_KEYS)[number];

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface RemoteSessionContext {
  enabled: boolean;
  sessionId: string | undefined;
  /** Generic upstream base URL — no default is baked in; callers supply it. */
  baseUrl: string;
}

export interface UpstreamProxyBootstrap {
  remote: RemoteSessionContext;
  upstreamProxyEnabled: boolean;
  tokenPath: string;
  caBundlePath: string;
  systemCaPath: string;
  /** Token read from `tokenPath` at construction time; `undefined` if absent. */
  token: string | undefined;
}

export interface UpstreamProxyState {
  enabled: boolean;
  proxyUrl: string | undefined;
  caBundlePath: string | undefined;
  noProxy: string;
}

// ---------------------------------------------------------------------------
// RemoteSessionContext
// ---------------------------------------------------------------------------

/**
 * Build a RemoteSessionContext from a real process environment.
 *
 * @param baseUrlFallback - Default base URL when the env does not set one.
 */
export function remoteSessionContextFromEnv(
  baseUrlFallback: string,
): RemoteSessionContext {
  return remoteSessionContextFromEnvMap(
    Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<
        [string, string]
      >,
    ),
    baseUrlFallback,
  );
}

/**
 * Build a RemoteSessionContext from an injectable env map (for tests).
 *
 * @param envMap          - Key/value pairs representing the environment.
 * @param baseUrlFallback - Default base URL when the env does not provide one.
 */
export function remoteSessionContextFromEnvMap(
  envMap: Record<string, string>,
  baseUrlFallback: string,
): RemoteSessionContext {
  const rawBaseUrl = envMap["REMOTE_BASE_URL"] ?? "";
  return {
    enabled: envTruthy(envMap["REMOTE_ENABLED"]),
    sessionId: nonEmpty(envMap["REMOTE_SESSION_ID"]),
    baseUrl: rawBaseUrl.length > 0 ? rawBaseUrl : baseUrlFallback,
  };
}

// ---------------------------------------------------------------------------
// UpstreamProxyBootstrap
// ---------------------------------------------------------------------------

/** Default locations resolved relative to $HOME. */
function defaultCaBundlePath(): string {
  return join(homedir(), ".ccr", "ca-bundle.crt");
}

const DEFAULT_SESSION_TOKEN_PATH = "/run/ccr/session_token";
const DEFAULT_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Build an UpstreamProxyBootstrap from a real process environment.
 *
 * @param baseUrlFallback - Passed through to `remoteSessionContextFromEnv`.
 */
export function upstreamProxyBootstrapFromEnv(
  baseUrlFallback: string,
): UpstreamProxyBootstrap {
  return upstreamProxyBootstrapFromEnvMap(
    Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<
        [string, string]
      >,
    ),
    baseUrlFallback,
  );
}

/**
 * Build an UpstreamProxyBootstrap from an injectable env map (for tests).
 *
 * @param envMap          - Key/value pairs representing the environment.
 * @param baseUrlFallback - Passed through to `remoteSessionContextFromEnvMap`.
 */
export function upstreamProxyBootstrapFromEnvMap(
  envMap: Record<string, string>,
  baseUrlFallback: string,
): UpstreamProxyBootstrap {
  const remote = remoteSessionContextFromEnvMap(envMap, baseUrlFallback);

  const tokenPath =
    nonEmpty(envMap["CCR_SESSION_TOKEN_PATH"]) ?? DEFAULT_SESSION_TOKEN_PATH;
  const systemCaPath =
    nonEmpty(envMap["CCR_SYSTEM_CA_BUNDLE"]) ?? DEFAULT_SYSTEM_CA_BUNDLE;
  const caBundlePath =
    nonEmpty(envMap["CCR_CA_BUNDLE_PATH"]) ?? defaultCaBundlePath();
  const token = readToken(tokenPath);

  return {
    remote,
    upstreamProxyEnabled: envTruthy(envMap["CCR_UPSTREAM_PROXY_ENABLED"]),
    tokenPath,
    caBundlePath,
    systemCaPath,
    token,
  };
}

/** Whether all preconditions for the upstream proxy are satisfied. */
export function bootstrapShouldEnable(b: UpstreamProxyBootstrap): boolean {
  return (
    b.remote.enabled &&
    b.upstreamProxyEnabled &&
    b.remote.sessionId !== undefined &&
    b.token !== undefined
  );
}

/** Derive the WebSocket URL for the upstream proxy endpoint. */
export function bootstrapWsUrl(b: UpstreamProxyBootstrap): string {
  return upstreamProxyWsUrl(b.remote.baseUrl);
}

/**
 * Produce a proxy state for a locally-bound port.
 *
 * @param b           - Bootstrap context.
 * @param port        - Locally-bound proxy port.
 * @param noProxyList - Comma-separated no-proxy hosts (caller-supplied).
 */
export function bootstrapStateForPort(
  b: UpstreamProxyBootstrap,
  port: number,
  noProxyList: string,
): UpstreamProxyState {
  if (!bootstrapShouldEnable(b)) {
    return disabledProxyState(noProxyList);
  }
  return {
    enabled: true,
    proxyUrl: `http://127.0.0.1:${port}`,
    caBundlePath: b.caBundlePath,
    noProxy: noProxyList,
  };
}

// ---------------------------------------------------------------------------
// UpstreamProxyState
// ---------------------------------------------------------------------------

/** A disabled (passthrough) proxy state. */
export function disabledProxyState(noProxyList: string): UpstreamProxyState {
  return {
    enabled: false,
    proxyUrl: undefined,
    caBundlePath: undefined,
    noProxy: noProxyList,
  };
}

/**
 * Produce the subprocess environment variables that activate the proxy.
 * Returns an empty record when the state is disabled.
 */
export function proxyStateSubprocessEnv(
  state: UpstreamProxyState,
): Record<string, string> {
  if (!state.enabled || state.proxyUrl === undefined || state.caBundlePath === undefined) {
    return {};
  }
  const { proxyUrl, caBundlePath, noProxy } = state;
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    SSL_CERT_FILE: caBundlePath,
    NODE_EXTRA_CA_CERTS: caBundlePath,
    REQUESTS_CA_BUNDLE: caBundlePath,
    CURL_CA_BUNDLE: caBundlePath,
  };
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Convert an HTTP(S) base URL to the corresponding WebSocket upstream-proxy
 * endpoint URL.
 */
export function upstreamProxyWsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let wsBase: string;
  if (base.startsWith("https://")) {
    wsBase = "wss://" + base.slice("https://".length);
  } else if (base.startsWith("http://")) {
    wsBase = "ws://" + base.slice("http://".length);
  } else {
    wsBase = "wss://" + base;
  }
  return wsBase + "/v1/code/upstreamproxy/ws";
}

/**
 * Return the subset of upstream proxy env keys that should be inherited by
 * subprocesses. Both `HTTPS_PROXY` **and** `SSL_CERT_FILE` must be present
 * for any keys to be inherited (all-or-nothing to avoid partial configs).
 */
export function inheritedUpstreamProxyEnv(
  envMap: Record<string, string>,
): Record<string, string> {
  if (!(envMap["HTTPS_PROXY"] && envMap["SSL_CERT_FILE"])) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const key of UPSTREAM_PROXY_ENV_KEYS) {
    if (envMap[key] !== undefined) {
      result[key] = envMap[key]!;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and trim a token file. Returns `undefined` when the file is absent or
 * empty after trimming.
 */
export function readToken(tokenPath: string): string | undefined {
  try {
    const contents = readFileSync(tokenPath, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return undefined;
    // Propagate unexpected I/O errors so callers can surface them.
    throw err;
  }
}

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
