import assert from "node:assert/strict";
import test from "node:test";

import {
  isProxyConfigEmpty,
  proxyConfigFromUrl,
  resolveProxyConfig,
  shouldBypassProxy,
} from "../dist/api/http-client.js";

// ---------------------------------------------------------------------------
// resolveProxyConfig
// ---------------------------------------------------------------------------

test("resolveProxyConfig: empty env yields empty config", () => {
  const config = resolveProxyConfig({});
  assert.equal(config.httpProxy, undefined);
  assert.equal(config.httpsProxy, undefined);
  assert.equal(config.noProxy, undefined);
  assert.equal(config.proxyUrl, undefined);
  assert.ok(isProxyConfigEmpty(config));
});

test("resolveProxyConfig: reads uppercase HTTP_PROXY / HTTPS_PROXY / NO_PROXY", () => {
  const config = resolveProxyConfig({
    HTTP_PROXY: "http://proxy.internal:3128",
    HTTPS_PROXY: "http://secure.internal:3129",
    NO_PROXY: "localhost,127.0.0.1,.corp",
  });
  assert.equal(config.httpProxy, "http://proxy.internal:3128");
  assert.equal(config.httpsProxy, "http://secure.internal:3129");
  assert.equal(config.noProxy, "localhost,127.0.0.1,.corp");
  assert.ok(!isProxyConfigEmpty(config));
});

test("resolveProxyConfig: falls back to lowercase keys when uppercase is absent", () => {
  const config = resolveProxyConfig({
    http_proxy: "http://lower.internal:3128",
    https_proxy: "http://lower-secure.internal:3129",
    no_proxy: ".lower",
  });
  assert.equal(config.httpProxy, "http://lower.internal:3128");
  assert.equal(config.httpsProxy, "http://lower-secure.internal:3129");
  assert.equal(config.noProxy, ".lower");
});

test("resolveProxyConfig: uppercase wins when both cases are set", () => {
  const config = resolveProxyConfig({
    HTTP_PROXY: "http://upper.internal:3128",
    http_proxy: "http://lower.internal:3128",
  });
  assert.equal(config.httpProxy, "http://upper.internal:3128");
});

test("resolveProxyConfig: empty string values are treated as unset", () => {
  const config = resolveProxyConfig({
    HTTP_PROXY: "",
    http_proxy: "",
    HTTPS_PROXY: "",
  });
  assert.equal(config.httpProxy, undefined);
  assert.equal(config.httpsProxy, undefined);
  assert.ok(isProxyConfigEmpty(config));
});

test("resolveProxyConfig: only https proxy set is not empty", () => {
  const config = resolveProxyConfig({ HTTPS_PROXY: "http://secure.internal:3129" });
  assert.equal(config.httpProxy, undefined);
  assert.equal(config.httpsProxy, "http://secure.internal:3129");
  assert.ok(!isProxyConfigEmpty(config));
});

test("resolveProxyConfig: proxyUrl is always undefined (set by proxyConfigFromUrl)", () => {
  const config = resolveProxyConfig({ HTTP_PROXY: "http://p:3128" });
  assert.equal(config.proxyUrl, undefined);
});

// ---------------------------------------------------------------------------
// proxyConfigFromUrl
// ---------------------------------------------------------------------------

test("proxyConfigFromUrl: sets proxyUrl and leaves per-scheme fields undefined", () => {
  const config = proxyConfigFromUrl("http://unified.internal:3128");
  assert.equal(config.proxyUrl, "http://unified.internal:3128");
  assert.equal(config.httpProxy, undefined);
  assert.equal(config.httpsProxy, undefined);
  assert.equal(config.noProxy, undefined);
  assert.ok(!isProxyConfigEmpty(config));
});

// ---------------------------------------------------------------------------
// isProxyConfigEmpty
// ---------------------------------------------------------------------------

test("isProxyConfigEmpty: config with only noProxy is considered empty", () => {
  // noProxy alone does not route traffic through a proxy
  const config = resolveProxyConfig({ NO_PROXY: "localhost" });
  assert.ok(isProxyConfigEmpty(config));
});

// ---------------------------------------------------------------------------
// shouldBypassProxy
// ---------------------------------------------------------------------------

test("shouldBypassProxy: returns false when noProxy is undefined", () => {
  assert.equal(shouldBypassProxy("example.com", undefined), false);
});

test("shouldBypassProxy: returns false when noProxy is empty string", () => {
  assert.equal(shouldBypassProxy("example.com", ""), false);
});

test("shouldBypassProxy: * wildcard bypasses all hosts", () => {
  assert.equal(shouldBypassProxy("example.com", "*"), true);
  assert.equal(shouldBypassProxy("internal.corp", "*"), true);
});

test("shouldBypassProxy: exact hostname match", () => {
  assert.equal(shouldBypassProxy("localhost", "localhost,127.0.0.1"), true);
  assert.equal(shouldBypassProxy("127.0.0.1", "localhost,127.0.0.1"), true);
  assert.equal(shouldBypassProxy("example.com", "localhost,127.0.0.1"), false);
});

test("shouldBypassProxy: leading-dot entry matches subdomains", () => {
  assert.equal(shouldBypassProxy("api.corp.example", ".corp.example"), true);
  assert.equal(shouldBypassProxy("corp.example", ".corp.example"), true);
  assert.equal(shouldBypassProxy("other.example", ".corp.example"), false);
});

test("shouldBypassProxy: matching is case-insensitive", () => {
  assert.equal(shouldBypassProxy("LocalHost", "localhost"), true);
  assert.equal(shouldBypassProxy("EXAMPLE.COM", ".example.com"), true);
});

test("shouldBypassProxy: comma-separated list with whitespace is handled", () => {
  const noProxy = "localhost , 127.0.0.1 , .corp";
  assert.equal(shouldBypassProxy("localhost", noProxy), true);
  assert.equal(shouldBypassProxy("proxy.corp", noProxy), true);
  assert.equal(shouldBypassProxy("external.io", noProxy), false);
});

test("shouldBypassProxy: host not in list returns false", () => {
  assert.equal(shouldBypassProxy("external.example.com", "localhost,.internal"), false);
});

test("shouldBypassProxy: empty entries in list are skipped", () => {
  // Trailing comma or double-comma should not throw
  assert.equal(shouldBypassProxy("localhost", "localhost,,"), true);
  assert.equal(shouldBypassProxy("other", ",,"), false);
});
