// Provider-neutral local prompt-cache tracking layer.
// Ported from claw-rust/crates/api/src/prompt_cache.rs.
//
// This module tracks hit/miss statistics, token-savings estimation, and
// cache-break detection for prompt caching. It does NOT emit any
// provider-specific cache_control headers — that is the API layer's concern.
//
// Persistence is injectable so tests can use an in-memory store without
// touching the filesystem. The clock is injectable for deterministic testing.

// ---------------------------------------------------------------------------
// FNV-1a (64-bit) — pure, deterministic, no BigInt arithmetic
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit offset basis, expressed as two 32-bit halves [hi, lo]. */
const FNV_OFFSET_HI = 0xcbf29ce4 >>> 0;
const FNV_OFFSET_LO = 0x84222325 >>> 0;

/** FNV-1a 64-bit prime, expressed as two 32-bit halves [hi, lo]. */
const FNV_PRIME_HI = 0x00000100 >>> 0;
const FNV_PRIME_LO = 0x000001b3 >>> 0;

/**
 * Multiply two 64-bit values (represented as [hi32, lo32] pairs) modulo 2^64.
 * Only the lower 64 bits are kept — identical to Rust's wrapping_mul.
 */
function mul64(aHi: number, aLo: number, bHi: number, bLo: number): [number, number] {
  // Split into 16-bit limbs to avoid float precision loss in JS.
  const aL = aLo & 0xffff;
  const aM = (aLo >>> 16) & 0xffff;
  const aH = aHi & 0xffff;
  const aHH = (aHi >>> 16) & 0xffff;

  const bL = bLo & 0xffff;
  const bM = (bLo >>> 16) & 0xffff;
  const bH = bHi & 0xffff;

  // We only need the lower 64 bits, so skip terms above bit 63.
  let lo = Math.imul(aL, bL);
  let carry = (lo >>> 16) + Math.imul(aM, bL) + Math.imul(aL, bM);
  lo = ((carry & 0xffff) << 16) | (lo & 0xffff);
  let hi =
    (carry >>> 16) +
    Math.imul(aH, bL) +
    Math.imul(aM, bM) +
    Math.imul(aL, bH) +
    Math.imul(aHH, bL) +
    Math.imul(aH, bM) +
    Math.imul(aM, bH) +
    Math.imul(aL, (bHi >>> 16) & 0xffff);

  return [hi >>> 0, lo >>> 0];
}

/**
 * Compute FNV-1a 64-bit hash of a byte array.
 * Returns the hash as a pair [hi32, lo32].
 */
export function fnv1a64(bytes: Uint8Array): [number, number] {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    [hi, lo] = mul64(hi, lo, FNV_PRIME_HI, FNV_PRIME_LO);
  }
  return [hi, lo];
}

/** Format a [hi, lo] pair as a 16-character lowercase hex string. */
function formatHex64(hi: number, lo: number): string {
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/** Stable JSON serialisation used for hashing (keys sorted recursively). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const sorted = Object.keys(value as object)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + stableJson((value as Record<string, unknown>)[k]));
  return "{" + sorted.join(",") + "}";
}

const TEXT_ENCODER = new TextEncoder();

/** Hash any JSON-serialisable value with FNV-1a 64-bit. */
export function hashValue(value: unknown): [number, number] {
  const bytes = TEXT_ENCODER.encode(stableJson(value));
  return fnv1a64(bytes);
}

/** Hex hash string for a full request object (versioned prefix). */
export function requestHashHex(request: RequestLike): string {
  const [hi, lo] = hashValue(request);
  return `v1-${formatHex64(hi, lo)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEFAULT_COMPLETION_TTL_SECS = 30;
const DEFAULT_PROMPT_TTL_SECS = 5 * 60;
const DEFAULT_BREAK_MIN_DROP = 2_000;
const MAX_SANITIZED_LENGTH = 80;
const FINGERPRINT_VERSION = 1;

/** Minimal shape of a request object needed for fingerprinting. */
export type RequestLike = {
  model?: unknown;
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
  [key: string]: unknown;
};

/** Usage tokens from an API response. */
export type CacheUsage = {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type PromptCacheConfig = {
  sessionId: string;
  /** Seconds a completion-cache entry remains valid (default: 30). */
  completionTtlSecs: number;
  /** Seconds before a prompt TTL expiry is considered expected (default: 300). */
  promptTtlSecs: number;
  /** Minimum token drop to trigger cache-break detection (default: 2000). */
  cacheBreakMinDrop: number;
};

export function defaultPromptCacheConfig(sessionId = "default"): PromptCacheConfig {
  return {
    sessionId,
    completionTtlSecs: DEFAULT_COMPLETION_TTL_SECS,
    promptTtlSecs: DEFAULT_PROMPT_TTL_SECS,
    cacheBreakMinDrop: DEFAULT_BREAK_MIN_DROP,
  };
}

export type PromptCacheStats = {
  trackedRequests: number;
  completionCacheHits: number;
  completionCacheMisses: number;
  completionCacheWrites: number;
  expectedInvalidations: number;
  unexpectedCacheBreaks: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  lastCacheCreationInputTokens: number | undefined;
  lastCacheReadInputTokens: number | undefined;
  lastRequestHash: string | undefined;
  lastCompletionCacheKey: string | undefined;
  lastBreakReason: string | undefined;
  lastCacheSource: string | undefined;
};

export function emptyStats(): PromptCacheStats {
  return {
    trackedRequests: 0,
    completionCacheHits: 0,
    completionCacheMisses: 0,
    completionCacheWrites: 0,
    expectedInvalidations: 0,
    unexpectedCacheBreaks: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    lastCacheCreationInputTokens: undefined,
    lastCacheReadInputTokens: undefined,
    lastRequestHash: undefined,
    lastCompletionCacheKey: undefined,
    lastBreakReason: undefined,
    lastCacheSource: undefined,
  };
}

export type CacheBreakEvent = {
  unexpected: boolean;
  reason: string;
  previousCacheReadInputTokens: number;
  currentCacheReadInputTokens: number;
  tokenDrop: number;
};

export type PromptCacheRecord = {
  cacheBreak: CacheBreakEvent | undefined;
  stats: PromptCacheStats;
};

// ---------------------------------------------------------------------------
// Internal tracked state
// ---------------------------------------------------------------------------

type TrackedPromptState = {
  observedAtSecs: number;
  fingerprintVersion: number;
  modelHashHi: number;
  modelHashLo: number;
  systemHashHi: number;
  systemHashLo: number;
  toolsHashHi: number;
  toolsHashLo: number;
  messagesHashHi: number;
  messagesHashLo: number;
  cacheReadInputTokens: number;
};

function stateFromRequest(request: RequestLike, usage: CacheUsage, nowSecs: number): TrackedPromptState {
  const [mHi, mLo] = hashValue(request.model);
  const [sHi, sLo] = hashValue(request.system);
  const [tHi, tLo] = hashValue(request.tools);
  const [msHi, msLo] = hashValue(request.messages);
  return {
    observedAtSecs: nowSecs,
    fingerprintVersion: FINGERPRINT_VERSION,
    modelHashHi: mHi,
    modelHashLo: mLo,
    systemHashHi: sHi,
    systemHashLo: sLo,
    toolsHashHi: tHi,
    toolsHashLo: tLo,
    messagesHashHi: msHi,
    messagesHashLo: msLo,
    cacheReadInputTokens: usage.cacheReadInputTokens,
  };
}

// ---------------------------------------------------------------------------
// Cache-break detection
// ---------------------------------------------------------------------------

function detectCacheBreak(
  config: PromptCacheConfig,
  previous: TrackedPromptState | undefined,
  current: TrackedPromptState,
): CacheBreakEvent | undefined {
  if (previous === undefined) return undefined;

  if (previous.fingerprintVersion !== current.fingerprintVersion) {
    const tokenDrop = Math.max(0, previous.cacheReadInputTokens - current.cacheReadInputTokens);
    return {
      unexpected: false,
      reason: `fingerprint version changed (v${previous.fingerprintVersion} -> v${current.fingerprintVersion})`,
      previousCacheReadInputTokens: previous.cacheReadInputTokens,
      currentCacheReadInputTokens: current.cacheReadInputTokens,
      tokenDrop,
    };
  }

  const tokenDrop = Math.max(0, previous.cacheReadInputTokens - current.cacheReadInputTokens);
  if (tokenDrop < config.cacheBreakMinDrop) return undefined;

  const reasons: string[] = [];
  if (
    previous.modelHashHi !== current.modelHashHi ||
    previous.modelHashLo !== current.modelHashLo
  ) {
    reasons.push("model changed");
  }
  if (
    previous.systemHashHi !== current.systemHashHi ||
    previous.systemHashLo !== current.systemHashLo
  ) {
    reasons.push("system prompt changed");
  }
  if (
    previous.toolsHashHi !== current.toolsHashHi ||
    previous.toolsHashLo !== current.toolsHashLo
  ) {
    reasons.push("tool definitions changed");
  }
  if (
    previous.messagesHashHi !== current.messagesHashHi ||
    previous.messagesHashLo !== current.messagesHashLo
  ) {
    reasons.push("message payload changed");
  }

  const elapsed = current.observedAtSecs - previous.observedAtSecs;

  if (reasons.length === 0) {
    if (elapsed > config.promptTtlSecs) {
      return {
        unexpected: false,
        reason: `possible prompt cache TTL expiry after ${elapsed}s`,
        previousCacheReadInputTokens: previous.cacheReadInputTokens,
        currentCacheReadInputTokens: current.cacheReadInputTokens,
        tokenDrop,
      };
    }
    return {
      unexpected: true,
      reason: "cache read tokens dropped while prompt fingerprint remained stable",
      previousCacheReadInputTokens: previous.cacheReadInputTokens,
      currentCacheReadInputTokens: current.cacheReadInputTokens,
      tokenDrop,
    };
  }

  return {
    unexpected: false,
    reason: reasons.join(", "),
    previousCacheReadInputTokens: previous.cacheReadInputTokens,
    currentCacheReadInputTokens: current.cacheReadInputTokens,
    tokenDrop,
  };
}

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------

function applyUsageToStats(
  stats: PromptCacheStats,
  usage: CacheUsage,
  requestHash: string,
  source: string,
): void {
  stats.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
  stats.totalCacheReadInputTokens += usage.cacheReadInputTokens;
  stats.lastCacheCreationInputTokens = usage.cacheCreationInputTokens;
  stats.lastCacheReadInputTokens = usage.cacheReadInputTokens;
  stats.lastRequestHash = requestHash;
  stats.lastCacheSource = source;
}

// ---------------------------------------------------------------------------
// Completion-cache entry shape (for injectable storage)
// ---------------------------------------------------------------------------

export type CompletionCacheEntry<R> = {
  cachedAtSecs: number;
  fingerprintVersion: number;
  response: R;
};

/** Injectable persistence contract. In-memory by default. */
export type CacheStorage<R> = {
  /** Read a completion entry by hash key. Returns undefined when absent. */
  getCompletion(key: string): CompletionCacheEntry<R> | undefined;
  /** Write a completion entry. */
  setCompletion(key: string, entry: CompletionCacheEntry<R>): void;
  /** Delete a completion entry (used when expired or stale). */
  deleteCompletion(key: string): void;
  /** Load persisted stats (called once at construction). */
  loadStats(): PromptCacheStats | undefined;
  /** Persist the current stats snapshot. */
  saveStats(stats: PromptCacheStats): void;
  /** Load the previous tracked state (called once at construction). */
  loadPreviousState(): TrackedPromptState | undefined;
  /** Persist the current tracked state. */
  savePreviousState(state: TrackedPromptState): void;
};

/** In-memory implementation — suitable for tests and ephemeral sessions. */
export function inMemoryStorage<R>(): CacheStorage<R> {
  const completions = new Map<string, CompletionCacheEntry<R>>();
  let stats: PromptCacheStats | undefined;
  let previousState: TrackedPromptState | undefined;
  return {
    getCompletion: (key) => completions.get(key),
    setCompletion: (key, entry) => { completions.set(key, entry); },
    deleteCompletion: (key) => { completions.delete(key); },
    loadStats: () => stats,
    saveStats: (s) => { stats = { ...s }; },
    loadPreviousState: () => previousState,
    savePreviousState: (state) => { previousState = { ...state }; },
  };
}

// ---------------------------------------------------------------------------
// Sanitise a session id for use as a path segment
// ---------------------------------------------------------------------------

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const [hi, lo] = fnv1a64(TEXT_ENCODER.encode(value));
  const suffix = `-${formatHex64(hi, lo)}`;
  return sanitized.slice(0, MAX_SANITIZED_LENGTH - suffix.length) + suffix;
}

// ---------------------------------------------------------------------------
// PromptCache — the main tracking class
// ---------------------------------------------------------------------------

export class PromptCache<R extends object = object> {
  private readonly config: PromptCacheConfig;
  private readonly storage: CacheStorage<R>;
  private readonly clock: () => number;
  private stats: PromptCacheStats;
  private previous: TrackedPromptState | undefined;

  constructor(options: {
    config?: PromptCacheConfig;
    storage?: CacheStorage<R>;
    /** Injectable clock; returns current time as Unix seconds. */
    clock?: () => number;
  } = {}) {
    this.config = options.config ?? defaultPromptCacheConfig();
    this.storage = options.storage ?? inMemoryStorage<R>();
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.stats = this.storage.loadStats() ?? emptyStats();
    this.previous = this.storage.loadPreviousState();
  }

  getStats(): PromptCacheStats {
    return { ...this.stats };
  }

  /**
   * Look up a cached completion for the given request.
   * Returns the cached response if found and not expired; updates hit/miss counts.
   */
  lookupCompletion(request: RequestLike): R | undefined {
    const key = requestHashHex(request);
    const entry = this.storage.getCompletion(key);

    if (entry === undefined) {
      this.stats.completionCacheMisses++;
      this.stats.lastCompletionCacheKey = key;
      this.storage.saveStats(this.stats);
      return undefined;
    }

    if (entry.fingerprintVersion !== FINGERPRINT_VERSION) {
      this.stats.completionCacheMisses++;
      this.stats.lastCompletionCacheKey = key;
      this.storage.deleteCompletion(key);
      this.storage.saveStats(this.stats);
      return undefined;
    }

    const nowSecs = this.clock();
    const expired = nowSecs - entry.cachedAtSecs >= this.config.completionTtlSecs;
    this.stats.lastCompletionCacheKey = key;
    if (expired) {
      this.stats.completionCacheMisses++;
      this.storage.deleteCompletion(key);
      this.storage.saveStats(this.stats);
      return undefined;
    }

    this.stats.completionCacheHits++;
    this.storage.saveStats(this.stats);
    return entry.response;
  }

  /**
   * Record a live API response. Persists the response in the completion cache,
   * updates stats, and runs cache-break detection.
   */
  recordResponse(request: RequestLike, response: R, usage: CacheUsage): PromptCacheRecord {
    return this.recordInternal(request, usage, response);
  }

  /**
   * Record usage only (no response body to cache). Useful when the caller
   * already has usage stats but did not capture the full response.
   */
  recordUsage(request: RequestLike, usage: CacheUsage): PromptCacheRecord {
    return this.recordInternal(request, usage, undefined);
  }

  private recordInternal(
    request: RequestLike,
    usage: CacheUsage,
    response: R | undefined,
  ): PromptCacheRecord {
    const key = requestHashHex(request);
    const nowSecs = this.clock();
    const current = stateFromRequest(request, usage, nowSecs);
    const cacheBreak = detectCacheBreak(this.config, this.previous, current);

    this.stats.trackedRequests++;
    applyUsageToStats(this.stats, usage, key, "api-response");

    if (cacheBreak !== undefined) {
      if (cacheBreak.unexpected) {
        this.stats.unexpectedCacheBreaks++;
      } else {
        this.stats.expectedInvalidations++;
      }
      this.stats.lastBreakReason = cacheBreak.reason;
    }

    this.previous = current;
    this.storage.savePreviousState(current);

    if (response !== undefined) {
      this.storage.setCompletion(key, {
        cachedAtSecs: nowSecs,
        fingerprintVersion: FINGERPRINT_VERSION,
        response,
      });
      this.stats.completionCacheWrites++;
    }

    this.storage.saveStats(this.stats);
    return { cacheBreak, stats: { ...this.stats } };
  }
}
