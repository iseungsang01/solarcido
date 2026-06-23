// HTTP proxy configuration helpers. Pure — all functions accept an env record
// as input rather than reading process.env directly, making them trivially
// testable. Ported from claw-rust/crates/api/src/http_client.rs.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Snapshot of the proxy-related environment variables that influence the
 * outbound HTTP client. Captured up-front so callers can inspect and test
 * the resolved configuration without re-reading the process environment.
 *
 * When `proxyUrl` is set it acts as a unified catch-all for both HTTP and
 * HTTPS traffic and takes precedence over the per-scheme fields.
 */
export type ProxyConfig = {
  readonly httpProxy: string | undefined;
  readonly httpsProxy: string | undefined;
  readonly noProxy: string | undefined;
  /** Optional unified proxy URL (overrides `httpProxy` / `httpsProxy`). */
  readonly proxyUrl: string | undefined;
};

// ---------------------------------------------------------------------------
// Env-var key pairs (upper then lower, mirrors Rust HTTP_PROXY_KEYS etc.)
// ---------------------------------------------------------------------------

const HTTP_PROXY_KEYS = ["HTTP_PROXY", "http_proxy"] as const;
const HTTPS_PROXY_KEYS = ["HTTPS_PROXY", "https_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the first non-empty value found among `keys` in `env`. */
function firstNonEmpty(
  keys: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `ProxyConfig` from an env record. Honours both upper- and
 * lower-case spellings (upper wins, matching curl / git / the Rust port).
 *
 * Defaults to `process.env` when `env` is omitted.
 */
export function resolveProxyConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProxyConfig {
  return {
    httpProxy: firstNonEmpty(HTTP_PROXY_KEYS, env),
    httpsProxy: firstNonEmpty(HTTPS_PROXY_KEYS, env),
    noProxy: firstNonEmpty(NO_PROXY_KEYS, env),
    proxyUrl: undefined,
  };
}

/**
 * Create a `ProxyConfig` with a single unified proxy URL that covers both
 * HTTP and HTTPS traffic (config-file alternative to per-scheme env vars).
 */
export function proxyConfigFromUrl(proxyUrl: string): ProxyConfig {
  return { httpProxy: undefined, httpsProxy: undefined, noProxy: undefined, proxyUrl };
}

/** True when the config carries no proxy information at all. */
export function isProxyConfigEmpty(config: ProxyConfig): boolean {
  return (
    config.proxyUrl === undefined &&
    config.httpProxy === undefined &&
    config.httpsProxy === undefined
  );
}

/**
 * Determine whether `host` should bypass the proxy according to a
 * `NO_PROXY` / `no_proxy` value string.
 *
 * Rules (mirrors curl's no_proxy semantics):
 * - The value is a comma-separated list of hostnames / domain suffixes.
 * - A leading dot (`.corp.example`) means "match any subdomain".
 * - `*` means "bypass for all hosts".
 * - Matching is case-insensitive.
 *
 * @param host     Bare hostname or IP (no scheme, no port).
 * @param noProxy  The raw NO_PROXY env-var value (may be empty / undefined).
 */
export function shouldBypassProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy || noProxy.trim() === "") return false;

  const normalHost = host.toLowerCase().trim();

  for (const rawEntry of noProxy.split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;

    // Leading dot — match the suffix (including the bare parent domain)
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1); // strip the dot
      if (normalHost === suffix || normalHost.endsWith("." + suffix)) return true;
      continue;
    }

    if (normalHost === entry) return true;
  }

  return false;
}
