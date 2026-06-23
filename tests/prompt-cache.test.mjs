import assert from "node:assert/strict";
import test from "node:test";

import {
  fnv1a64,
  hashValue,
  requestHashHex,
  sanitizePathSegment,
  PromptCache,
  defaultPromptCacheConfig,
  emptyStats,
  inMemoryStorage,
} from "../dist/api/prompt-cache.js";

// ---------------------------------------------------------------------------
// fnv1a64 — pure, deterministic hash
// ---------------------------------------------------------------------------

test("fnv1a64: empty input yields FNV offset basis", () => {
  const [hi, lo] = fnv1a64(new Uint8Array(0));
  // FNV offset basis: 0xcbf29ce484222325
  assert.equal(hi, 0xcbf29ce4);
  assert.equal(lo, 0x84222325);
});

test("fnv1a64: same bytes always produce same result", () => {
  const bytes = new TextEncoder().encode("hello world");
  const [hi1, lo1] = fnv1a64(bytes);
  const [hi2, lo2] = fnv1a64(bytes);
  assert.equal(hi1, hi2);
  assert.equal(lo1, lo2);
});

test("fnv1a64: different bytes produce different results", () => {
  const enc = new TextEncoder();
  const [hi1, lo1] = fnv1a64(enc.encode("alpha"));
  const [hi2, lo2] = fnv1a64(enc.encode("beta"));
  assert.ok(hi1 !== hi2 || lo1 !== lo2, "distinct inputs must hash differently");
});

// ---------------------------------------------------------------------------
// hashValue — JSON-serialisable values
// ---------------------------------------------------------------------------

test("hashValue: null hashes deterministically", () => {
  const [h1, l1] = hashValue(null);
  const [h2, l2] = hashValue(null);
  assert.equal(h1, h2);
  assert.equal(l1, l2);
});

test("hashValue: object key order does not affect hash", () => {
  const [h1, l1] = hashValue({ b: 2, a: 1 });
  const [h2, l2] = hashValue({ a: 1, b: 2 });
  assert.equal(h1, h2, "key order must not affect hash (stable JSON)");
  assert.equal(l1, l2);
});

test("hashValue: distinct objects produce distinct hashes", () => {
  const [h1, l1] = hashValue({ x: "foo" });
  const [h2, l2] = hashValue({ x: "bar" });
  assert.ok(h1 !== h2 || l1 !== l2);
});

// ---------------------------------------------------------------------------
// requestHashHex — versioned prefix
// ---------------------------------------------------------------------------

test("requestHashHex: starts with v1- prefix", () => {
  const hash = requestHashHex({ model: "solar", messages: [] });
  assert.ok(hash.startsWith("v1-"), `expected v1- prefix, got ${hash}`);
});

test("requestHashHex: identical requests produce identical hashes", () => {
  const req = { model: "solar-pro3-260323", system: "sys", tools: null, messages: [{ role: "user", content: "hi" }] };
  assert.equal(requestHashHex(req), requestHashHex(req));
});

test("requestHashHex: different messages produce different hashes", () => {
  const req1 = { model: "m", messages: [{ role: "user", content: "hello" }] };
  const req2 = { model: "m", messages: [{ role: "user", content: "world" }] };
  assert.notEqual(requestHashHex(req1), requestHashHex(req2));
});

// ---------------------------------------------------------------------------
// sanitizePathSegment
// ---------------------------------------------------------------------------

test("sanitizePathSegment: replaces non-alphanumeric chars with dashes", () => {
  assert.equal(sanitizePathSegment("session:/with spaces"), "session--with-spaces");
});

test("sanitizePathSegment: short value is unchanged except substitutions", () => {
  assert.equal(sanitizePathSegment("abc-123"), "abc-123");
});

test("sanitizePathSegment: long value is capped at 80 chars", () => {
  const long = "x".repeat(200);
  const result = sanitizePathSegment(long);
  assert.ok(result.length <= 80, `expected <= 80 chars, got ${result.length}`);
});

test("sanitizePathSegment: truncated long value includes a hash suffix", () => {
  const long = "y".repeat(200);
  const result = sanitizePathSegment(long);
  // The suffix is appended after truncation, so the total must still be <= 80.
  assert.ok(result.length <= 80);
  // The suffix is a dash followed by hex characters.
  assert.match(result, /-[0-9a-f]+$/);
});

// ---------------------------------------------------------------------------
// emptyStats
// ---------------------------------------------------------------------------

test("emptyStats: all numeric fields are zero, optionals are undefined", () => {
  const s = emptyStats();
  assert.equal(s.trackedRequests, 0);
  assert.equal(s.completionCacheHits, 0);
  assert.equal(s.completionCacheMisses, 0);
  assert.equal(s.completionCacheWrites, 0);
  assert.equal(s.unexpectedCacheBreaks, 0);
  assert.equal(s.expectedInvalidations, 0);
  assert.equal(s.lastCacheCreationInputTokens, undefined);
  assert.equal(s.lastCacheReadInputTokens, undefined);
});

// ---------------------------------------------------------------------------
// PromptCache — hit / miss / savings tracking (injected in-memory storage)
// ---------------------------------------------------------------------------

function makeRequest(content) {
  return { model: "solar-pro3-260323", system: "sys", tools: null, messages: [{ role: "user", content }] };
}

function makeUsage(cacheRead = 0, cacheCreate = 0) {
  return { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: cacheCreate, cacheReadInputTokens: cacheRead };
}

test("PromptCache: miss on empty cache", () => {
  const cache = new PromptCache({ storage: inMemoryStorage() });
  const req = makeRequest("hello");
  assert.equal(cache.lookupCompletion(req), undefined);
  assert.equal(cache.getStats().completionCacheMisses, 1);
});

test("PromptCache: hit after recording response", () => {
  const cache = new PromptCache({ storage: inMemoryStorage() });
  const req = makeRequest("cache me");
  const response = { text: "cached answer" };
  cache.recordResponse(req, response, makeUsage(100));
  const hit = cache.lookupCompletion(req);
  assert.deepEqual(hit, response);
  assert.equal(cache.getStats().completionCacheHits, 1);
  assert.equal(cache.getStats().completionCacheWrites, 1);
});

test("PromptCache: distinct requests do not collide", () => {
  const cache = new PromptCache({ storage: inMemoryStorage() });
  cache.recordResponse(makeRequest("first"), { text: "first" }, makeUsage());
  assert.equal(cache.lookupCompletion(makeRequest("second")), undefined);
});

test("PromptCache: expired entries are not returned", () => {
  let now = 1_000_000;
  const config = { ...defaultPromptCacheConfig("test"), completionTtlSecs: 30 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });

  const req = makeRequest("expire me");
  cache.recordResponse(req, { text: "stale" }, makeUsage());

  // Advance clock past TTL.
  now += 31;
  assert.equal(cache.lookupCompletion(req), undefined);
  assert.equal(cache.getStats().completionCacheHits, 0);
  assert.equal(cache.getStats().completionCacheMisses, 1);
});

test("PromptCache: zero-TTL config always misses", () => {
  let now = 1_000_000;
  const config = { ...defaultPromptCacheConfig("test"), completionTtlSecs: 0 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });
  const req = makeRequest("zero ttl");
  cache.recordResponse(req, { v: 1 }, makeUsage());
  now += 1; // any advance past 0s TTL
  assert.equal(cache.lookupCompletion(req), undefined);
});

test("PromptCache: stats accumulate token savings across turns", () => {
  const cache = new PromptCache({ storage: inMemoryStorage() });
  cache.recordUsage(makeRequest("turn1"), makeUsage(1000, 200));
  cache.recordUsage(makeRequest("turn2"), makeUsage(2000, 0));
  const stats = cache.getStats();
  assert.equal(stats.totalCacheReadInputTokens, 3000);
  assert.equal(stats.totalCacheCreationInputTokens, 200);
  assert.equal(stats.trackedRequests, 2);
});

// ---------------------------------------------------------------------------
// Cache-break detection via recordUsage
// ---------------------------------------------------------------------------

test("PromptCache: unexpected break when fingerprint stable but tokens drop", () => {
  let now = 1_000;
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 2000, promptTtlSecs: 300 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });
  const req = makeRequest("stable");

  cache.recordUsage(req, makeUsage(6000));
  now += 5; // well within prompt TTL
  const record = cache.recordUsage(req, makeUsage(1000));

  assert.ok(record.cacheBreak !== undefined, "break should be detected");
  assert.ok(record.cacheBreak.unexpected, "break should be unexpected");
  assert.ok(record.cacheBreak.reason.includes("stable"));
  assert.equal(record.cacheBreak.tokenDrop, 5000);
});

test("PromptCache: expected break when message payload changes", () => {
  let now = 1_000;
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 2000 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });

  cache.recordUsage(makeRequest("first"), makeUsage(6000));
  now += 5;
  const record = cache.recordUsage(makeRequest("second"), makeUsage(1000));

  assert.ok(record.cacheBreak !== undefined);
  assert.ok(!record.cacheBreak.unexpected, "payload change should be expected");
  assert.ok(record.cacheBreak.reason.includes("message payload changed"));
});

test("PromptCache: expected break after prompt TTL expiry", () => {
  let now = 1_000;
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 2000, promptTtlSecs: 300 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });
  const req = makeRequest("ttl-break");

  cache.recordUsage(req, makeUsage(6000));
  now += 301; // exceed TTL
  const record = cache.recordUsage(req, makeUsage(1000));

  assert.ok(record.cacheBreak !== undefined);
  assert.ok(!record.cacheBreak.unexpected, "TTL expiry should be expected");
  assert.ok(record.cacheBreak.reason.includes("TTL"));
});

test("PromptCache: no break when token drop is below threshold", () => {
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 2000 };
  const cache = new PromptCache({ config, storage: inMemoryStorage() });
  const req = makeRequest("small-drop");

  cache.recordUsage(req, makeUsage(5000));
  const record = cache.recordUsage(req, makeUsage(4500)); // drop = 500 < 2000

  assert.equal(record.cacheBreak, undefined, "small drop must not trigger break");
});

test("PromptCache: unexpected break increments counter", () => {
  let now = 1_000;
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 100, promptTtlSecs: 9999 };
  const cache = new PromptCache({ config, storage: inMemoryStorage(), clock: () => now });
  const req = makeRequest("count-break");

  cache.recordUsage(req, makeUsage(5000));
  now += 1;
  cache.recordUsage(req, makeUsage(1000));

  assert.equal(cache.getStats().unexpectedCacheBreaks, 1);
  assert.equal(cache.getStats().expectedInvalidations, 0);
});

test("PromptCache: expected break increments invalidations counter", () => {
  const config = { ...defaultPromptCacheConfig(), cacheBreakMinDrop: 100 };
  const cache = new PromptCache({ config, storage: inMemoryStorage() });

  cache.recordUsage(makeRequest("req-a"), makeUsage(5000));
  cache.recordUsage(makeRequest("req-b"), makeUsage(1000));

  const stats = cache.getStats();
  assert.equal(stats.expectedInvalidations, 1);
  assert.equal(stats.unexpectedCacheBreaks, 0);
});
