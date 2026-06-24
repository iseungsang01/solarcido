// Provider registry: model-to-provider routing table, alias resolution, and
// max-token limits. Pure and deterministic — no I/O, no side effects.
// Ported from claw-rust/crates/api/src/providers/mod.rs.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union of known provider kinds. "anthropic" is recognised as a
 *  known kind (for completeness and future use) but is NOT wired to any client
 *  in this codebase — Solarcido ships with the Upstage Solar client only. */
export type ProviderKind =
  | "upstage"
  | "openai-compatible"
  | "xai"
  | "openai"
  | "dashscope"
  | "anthropic";

export type ProviderMetadata = {
  readonly provider: ProviderKind;
  /** Primary env-var name for the API key. */
  readonly authEnv: string;
  /** Env-var name used to override the base URL. */
  readonly baseUrlEnv: string;
  /** Fallback base URL used when `baseUrlEnv` is not set. */
  readonly defaultBaseUrl: string;
};

export type ModelTokenLimit = {
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number;
};

// ---------------------------------------------------------------------------
// Base-URL constants (mirrors openai_compat module constants in Rust)
// ---------------------------------------------------------------------------

const UPSTAGE_BASE_URL = "https://api.upstage.ai/v1";
const XAI_BASE_URL = "https://api.x.ai/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DASHSCOPE_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

// ---------------------------------------------------------------------------
// Static alias table
//
// Maps short aliases → provider metadata. Entries deliberately list every
// alias so `resolveModelAlias` can do a single pass without layered logic.
// ---------------------------------------------------------------------------

type AliasEntry = readonly [alias: string, meta: ProviderMetadata, canonical: string];

const UPSTAGE_META: ProviderMetadata = {
  provider: "upstage",
  authEnv: "UPSTAGE_API_KEY",
  baseUrlEnv: "UPSTAGE_BASE_URL",
  defaultBaseUrl: UPSTAGE_BASE_URL,
};

const XAI_META: ProviderMetadata = {
  provider: "xai",
  authEnv: "XAI_API_KEY",
  baseUrlEnv: "XAI_BASE_URL",
  defaultBaseUrl: XAI_BASE_URL,
};

const OPENAI_META: ProviderMetadata = {
  provider: "openai",
  authEnv: "OPENAI_API_KEY",
  baseUrlEnv: "OPENAI_BASE_URL",
  defaultBaseUrl: OPENAI_BASE_URL,
};

const DASHSCOPE_META: ProviderMetadata = {
  provider: "dashscope",
  authEnv: "DASHSCOPE_API_KEY",
  baseUrlEnv: "DASHSCOPE_BASE_URL",
  defaultBaseUrl: DASHSCOPE_BASE_URL,
};

// Seeded with Solar (Upstage) as the primary model plus generic aliases from
// the Rust registry (xai/grok, openai, dashscope/kimi).
const ALIAS_TABLE: ReadonlyArray<AliasEntry> = [
  // Upstage / Solar
  ["solar", UPSTAGE_META, "solar-pro3-260323"],
  ["solar-pro", UPSTAGE_META, "solar-pro3-260323"],
  ["solar-pro3", UPSTAGE_META, "solar-pro3-260323"],

  // xAI / Grok
  ["grok", XAI_META, "grok-3"],
  ["grok-3", XAI_META, "grok-3"],
  ["grok-mini", XAI_META, "grok-3-mini"],
  ["grok-3-mini", XAI_META, "grok-3-mini"],
  ["grok-2", XAI_META, "grok-2"],

  // OpenAI (explicit aliases)
  ["gpt-4o", OPENAI_META, "gpt-4o"],
  ["gpt-4o-mini", OPENAI_META, "gpt-4o-mini"],

  // DashScope / Kimi
  ["kimi", DASHSCOPE_META, "kimi-k2.5"],
  ["kimi-k2.5", DASHSCOPE_META, "kimi-k2.5"],
  ["kimi-k1.5", DASHSCOPE_META, "kimi-k1.5"],
];

// Build a lookup map for O(1) alias resolution.
const ALIAS_MAP = new Map<string, { meta: ProviderMetadata; canonical: string }>(
  ALIAS_TABLE.map(([alias, meta, canonical]) => [alias, { meta, canonical }]),
);

// ---------------------------------------------------------------------------
// Token limits for known canonical model names
// ---------------------------------------------------------------------------

const TOKEN_LIMITS: ReadonlyArray<[model: string, limit: ModelTokenLimit]> = [
  // maxOutputTokens measured against the live API: max_tokens > 4096 is honored
  // exactly and uncapped output runs far past it, so 4096 understated the real
  // ceiling; 16_384 matches the runtime's reserved output budget.
  ["solar-pro3-260323", { maxOutputTokens: 16_384, contextWindowTokens: 131_072 }],
  ["grok-3", { maxOutputTokens: 64_000, contextWindowTokens: 131_072 }],
  ["grok-3-mini", { maxOutputTokens: 64_000, contextWindowTokens: 131_072 }],
  ["kimi-k2.5", { maxOutputTokens: 16_384, contextWindowTokens: 256_000 }],
  ["kimi-k1.5", { maxOutputTokens: 16_384, contextWindowTokens: 256_000 }],
];

const TOKEN_LIMIT_MAP = new Map<string, ModelTokenLimit>(TOKEN_LIMITS);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a short alias (e.g. "solar", "grok", "kimi") to its canonical model
 * ID. Unrecognised strings are returned trimmed and unchanged.
 */
export function resolveModelAlias(model: string): string {
  const key = model.trim().toLowerCase();
  return ALIAS_MAP.get(key)?.canonical ?? model.trim();
}

/**
 * Return provider metadata for `model`, or `undefined` for completely unknown
 * models. Resolution order:
 *   1. Exact alias table match (case-insensitive).
 *   2. Canonical prefix rules (solar-, grok-, openai/, gpt-, qwen-, kimi-).
 */
export function metadataForModel(model: string): ProviderMetadata | undefined {
  const trimmed = model.trim();
  const key = trimmed.toLowerCase();

  // 1. Alias table match (handles both short aliases and exact canonical names)
  const aliasHit = ALIAS_MAP.get(key);
  if (aliasHit) return aliasHit.meta;

  // 2. Prefix-based routing for canonical model names not in the alias table
  if (key.startsWith("solar-") || key.startsWith("solar")) return UPSTAGE_META;
  if (key.startsWith("grok-") || key === "grok") return XAI_META;
  if (key.startsWith("openai/") || key.startsWith("gpt-")) return OPENAI_META;
  if (key.startsWith("qwen/") || key.startsWith("qwen-")) return DASHSCOPE_META;
  if (key.startsWith("kimi/") || key.startsWith("kimi-")) return DASHSCOPE_META;

  return undefined;
}

/**
 * Detect the provider kind for `model`. Falls back to "upstage" when the
 * model prefix is not recognised (Solarcido's default provider).
 *
 * When `env` is supplied (defaults to `process.env`) an explicit
 * `OPENAI_BASE_URL` in the environment takes precedence over the "upstage"
 * fallback for unrecognised model names — this handles local inference servers
 * (Ollama, vLLM) where model names carry no recognisable prefix.
 */
export function detectProviderKind(
  model: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProviderKind {
  const meta = metadataForModel(model);
  if (meta) return meta.provider;

  // When the user explicitly wired up an OpenAI-compatible base URL + key,
  // route unknown model names there rather than falling through to the default.
  if (env["OPENAI_BASE_URL"] && env["OPENAI_API_KEY"]) return "openai";

  // Last-resort: OPENAI_BASE_URL alone (e.g. Ollama without auth)
  if (env["OPENAI_BASE_URL"]) return "openai";

  // Solarcido default
  return "upstage";
}

/**
 * Return max output tokens for `model`. Uses the token-limit table after alias
 * resolution; falls back to a conservative 4 096 for unknown models.
 */
export function maxTokensForModel(model: string): number {
  return modelTokenLimit(model)?.maxOutputTokens ?? 4_096;
}

/**
 * Return the full token-limit record for `model` after alias resolution, or
 * `undefined` for models not in the table.
 */
export function modelTokenLimit(model: string): ModelTokenLimit | undefined {
  const canonical = resolveModelAlias(model);
  return TOKEN_LIMIT_MAP.get(canonical);
}
