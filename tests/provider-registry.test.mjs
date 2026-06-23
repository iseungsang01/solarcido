import assert from "node:assert/strict";
import test from "node:test";

import {
  detectProviderKind,
  maxTokensForModel,
  metadataForModel,
  modelTokenLimit,
  resolveModelAlias,
} from "../dist/api/provider-registry.js";

// ---------------------------------------------------------------------------
// resolveModelAlias
// ---------------------------------------------------------------------------

test("resolveModelAlias: solar short aliases resolve to solar-pro3-260323", () => {
  assert.equal(resolveModelAlias("solar"), "solar-pro3-260323");
  assert.equal(resolveModelAlias("solar-pro"), "solar-pro3-260323");
  assert.equal(resolveModelAlias("solar-pro3"), "solar-pro3-260323");
});

test("resolveModelAlias: grok aliases resolve to canonical grok names", () => {
  assert.equal(resolveModelAlias("grok"), "grok-3");
  assert.equal(resolveModelAlias("grok-3"), "grok-3");
  assert.equal(resolveModelAlias("grok-mini"), "grok-3-mini");
  assert.equal(resolveModelAlias("grok-3-mini"), "grok-3-mini");
  assert.equal(resolveModelAlias("grok-2"), "grok-2");
});

test("resolveModelAlias: kimi alias resolves to kimi-k2.5", () => {
  assert.equal(resolveModelAlias("kimi"), "kimi-k2.5");
});

test("resolveModelAlias: case-insensitive alias lookup", () => {
  assert.equal(resolveModelAlias("SOLAR"), "solar-pro3-260323");
  assert.equal(resolveModelAlias("KIMI"), "kimi-k2.5");
  assert.equal(resolveModelAlias("Grok"), "grok-3");
});

test("resolveModelAlias: unknown model is returned trimmed and unchanged", () => {
  assert.equal(resolveModelAlias("unknown-model-xyz"), "unknown-model-xyz");
  assert.equal(resolveModelAlias("  my-custom-model  "), "my-custom-model");
});

test("resolveModelAlias: already-canonical model passes through", () => {
  assert.equal(resolveModelAlias("solar-pro3-260323"), "solar-pro3-260323");
  assert.equal(resolveModelAlias("kimi-k2.5"), "kimi-k2.5");
});

// ---------------------------------------------------------------------------
// metadataForModel
// ---------------------------------------------------------------------------

test("metadataForModel: solar-pro3-260323 returns upstage metadata", () => {
  const meta = metadataForModel("solar-pro3-260323");
  assert.ok(meta, "solar-pro3-260323 must resolve to provider metadata");
  assert.equal(meta.provider, "upstage");
  assert.equal(meta.authEnv, "UPSTAGE_API_KEY");
  assert.ok(meta.defaultBaseUrl.includes("upstage.ai"), "base URL should point at Upstage");
});

test("metadataForModel: solar alias returns upstage metadata", () => {
  const meta = metadataForModel("solar");
  assert.ok(meta);
  assert.equal(meta.provider, "upstage");
});

test("metadataForModel: grok returns xai metadata", () => {
  const meta = metadataForModel("grok");
  assert.ok(meta);
  assert.equal(meta.provider, "xai");
  assert.equal(meta.authEnv, "XAI_API_KEY");
});

test("metadataForModel: grok-3-mini returns xai metadata", () => {
  const meta = metadataForModel("grok-3-mini");
  assert.ok(meta);
  assert.equal(meta.provider, "xai");
});

test("metadataForModel: openai/-prefixed model returns openai metadata", () => {
  const meta = metadataForModel("openai/gpt-4.1-mini");
  assert.ok(meta, "openai/ prefix must resolve to openai metadata");
  assert.equal(meta.provider, "openai");
  assert.equal(meta.authEnv, "OPENAI_API_KEY");
});

test("metadataForModel: gpt-4o returns openai metadata", () => {
  const meta = metadataForModel("gpt-4o");
  assert.ok(meta);
  assert.equal(meta.provider, "openai");
});

test("metadataForModel: qwen/-prefixed model returns dashscope metadata", () => {
  const meta = metadataForModel("qwen/qwen-max");
  assert.ok(meta, "qwen/ prefix must resolve to dashscope metadata");
  assert.equal(meta.provider, "dashscope");
  assert.equal(meta.authEnv, "DASHSCOPE_API_KEY");
  assert.ok(meta.defaultBaseUrl.includes("dashscope.aliyuncs.com"));
});

test("metadataForModel: bare qwen- prefix returns dashscope metadata", () => {
  const meta = metadataForModel("qwen-plus");
  assert.ok(meta);
  assert.equal(meta.provider, "dashscope");
});

test("metadataForModel: kimi-k2.5 returns dashscope metadata", () => {
  const meta = metadataForModel("kimi-k2.5");
  assert.ok(meta);
  assert.equal(meta.provider, "dashscope");
  assert.equal(meta.authEnv, "DASHSCOPE_API_KEY");
});

test("metadataForModel: kimi/-prefixed model returns dashscope metadata", () => {
  const meta = metadataForModel("kimi/kimi-k2.5");
  assert.ok(meta);
  assert.equal(meta.provider, "dashscope");
});

test("metadataForModel: completely unknown model returns undefined", () => {
  assert.equal(metadataForModel("totally-unknown-xyz"), undefined);
});

// ---------------------------------------------------------------------------
// detectProviderKind
// ---------------------------------------------------------------------------

test("detectProviderKind: solar model detects upstage", () => {
  assert.equal(detectProviderKind("solar-pro3-260323"), "upstage");
  assert.equal(detectProviderKind("solar"), "upstage");
});

test("detectProviderKind: grok model detects xai", () => {
  assert.equal(detectProviderKind("grok"), "xai");
  assert.equal(detectProviderKind("grok-3"), "xai");
});

test("detectProviderKind: openai/-prefixed model detects openai regardless of env", () => {
  // Even without any env vars set, prefix routing must win
  const kind = detectProviderKind("openai/gpt-4.1-mini", {});
  assert.equal(kind, "openai");
});

test("detectProviderKind: qwen prefix routes to dashscope", () => {
  assert.equal(detectProviderKind("qwen/qwen3-coder", {}), "dashscope");
  assert.equal(detectProviderKind("qwen-plus", {}), "dashscope");
});

test("detectProviderKind: unknown model with OPENAI_BASE_URL + OPENAI_API_KEY routes to openai", () => {
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", OPENAI_API_KEY: "dummy" };
  assert.equal(detectProviderKind("qwen2.5-coder:7b", env), "openai");
});

test("detectProviderKind: unknown model with OPENAI_BASE_URL alone routes to openai", () => {
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" };
  assert.equal(detectProviderKind("llama3:8b", env), "openai");
});

test("detectProviderKind: unknown model with empty env falls back to upstage", () => {
  assert.equal(detectProviderKind("totally-unknown", {}), "upstage");
});

// ---------------------------------------------------------------------------
// maxTokensForModel
// ---------------------------------------------------------------------------

test("maxTokensForModel: solar-pro3-260323 returns a positive number", () => {
  const tokens = maxTokensForModel("solar-pro3-260323");
  assert.ok(tokens > 0, "max tokens must be positive");
});

test("maxTokensForModel: solar alias resolves correctly", () => {
  assert.equal(maxTokensForModel("solar"), maxTokensForModel("solar-pro3-260323"));
});

test("maxTokensForModel: grok-3 returns 64000", () => {
  assert.equal(maxTokensForModel("grok-3"), 64_000);
});

test("maxTokensForModel: kimi-k2.5 returns 16384", () => {
  assert.equal(maxTokensForModel("kimi-k2.5"), 16_384);
});

test("maxTokensForModel: kimi alias resolves to kimi-k2.5 limits", () => {
  assert.equal(maxTokensForModel("kimi"), maxTokensForModel("kimi-k2.5"));
});

test("maxTokensForModel: unknown model returns conservative fallback (4096)", () => {
  assert.equal(maxTokensForModel("some-unknown-model"), 4_096);
});

// ---------------------------------------------------------------------------
// modelTokenLimit
// ---------------------------------------------------------------------------

test("modelTokenLimit: solar-pro3-260323 has both output and context window", () => {
  const limit = modelTokenLimit("solar-pro3-260323");
  assert.ok(limit, "solar-pro3-260323 should have a token limit entry");
  assert.ok(limit.maxOutputTokens > 0);
  assert.ok(limit.contextWindowTokens > 0);
});

test("modelTokenLimit: kimi-k2.5 has 256k context window", () => {
  const limit = modelTokenLimit("kimi-k2.5");
  assert.ok(limit);
  assert.equal(limit.contextWindowTokens, 256_000);
  assert.equal(limit.maxOutputTokens, 16_384);
});

test("modelTokenLimit: kimi-k1.5 has 256k context window", () => {
  const limit = modelTokenLimit("kimi-k1.5");
  assert.ok(limit);
  assert.equal(limit.contextWindowTokens, 256_000);
});

test("modelTokenLimit: grok-3 has 131072 context window", () => {
  const limit = modelTokenLimit("grok-3");
  assert.ok(limit);
  assert.equal(limit.contextWindowTokens, 131_072);
  assert.equal(limit.maxOutputTokens, 64_000);
});

test("modelTokenLimit: alias resolves before lookup", () => {
  // "grok-mini" resolves to "grok-3-mini"
  const viaAlias = modelTokenLimit("grok-mini");
  const direct = modelTokenLimit("grok-3-mini");
  assert.ok(viaAlias);
  assert.ok(direct);
  assert.equal(viaAlias.maxOutputTokens, direct.maxOutputTokens);
  assert.equal(viaAlias.contextWindowTokens, direct.contextWindowTokens);
});

test("modelTokenLimit: unknown model returns undefined", () => {
  assert.equal(modelTokenLimit("does-not-exist"), undefined);
});
