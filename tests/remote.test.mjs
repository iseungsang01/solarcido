import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  remoteSessionContextFromEnvMap,
  upstreamProxyBootstrapFromEnvMap,
  bootstrapShouldEnable,
  bootstrapWsUrl,
  bootstrapStateForPort,
  disabledProxyState,
  proxyStateSubprocessEnv,
  upstreamProxyWsUrl,
  inheritedUpstreamProxyEnv,
  readToken,
} from "../dist/runtime/remote.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDirCounter = 0;
function makeTempDir() {
  const dir = join(
    tmpdir(),
    `solarcido-remote-test-${process.pid}-${++tempDirCounter}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const BASE_URL = "https://proxy.example.com";
const NO_PROXY = "localhost,127.0.0.1";

// ---------------------------------------------------------------------------
// remoteSessionContextFromEnvMap
// ---------------------------------------------------------------------------

test("remoteSessionContextFromEnvMap: all env keys set → full context", () => {
  const ctx = remoteSessionContextFromEnvMap(
    {
      REMOTE_ENABLED: "true",
      REMOTE_SESSION_ID: "session-abc",
      REMOTE_BASE_URL: "https://custom.example.com",
    },
    BASE_URL,
  );
  assert.equal(ctx.enabled, true);
  assert.equal(ctx.sessionId, "session-abc");
  assert.equal(ctx.baseUrl, "https://custom.example.com");
});

test("remoteSessionContextFromEnvMap: REMOTE_BASE_URL empty → fallback used", () => {
  const ctx = remoteSessionContextFromEnvMap(
    { REMOTE_ENABLED: "1", REMOTE_BASE_URL: "" },
    BASE_URL,
  );
  assert.equal(ctx.baseUrl, BASE_URL);
});

test("remoteSessionContextFromEnvMap: REMOTE_BASE_URL absent → fallback used", () => {
  const ctx = remoteSessionContextFromEnvMap({}, BASE_URL);
  assert.equal(ctx.baseUrl, BASE_URL);
});

test("remoteSessionContextFromEnvMap: REMOTE_ENABLED falsy values → disabled", () => {
  for (const val of ["0", "false", "no", "off", ""]) {
    const ctx = remoteSessionContextFromEnvMap({ REMOTE_ENABLED: val }, BASE_URL);
    assert.equal(ctx.enabled, false, `expected false for REMOTE_ENABLED="${val}"`);
  }
});

test("remoteSessionContextFromEnvMap: REMOTE_ENABLED truthy values → enabled", () => {
  for (const val of ["1", "true", "yes", "on"]) {
    const ctx = remoteSessionContextFromEnvMap({ REMOTE_ENABLED: val }, BASE_URL);
    assert.equal(ctx.enabled, true, `expected true for REMOTE_ENABLED="${val}"`);
  }
});

test("remoteSessionContextFromEnvMap: empty REMOTE_SESSION_ID → undefined", () => {
  const ctx = remoteSessionContextFromEnvMap(
    { REMOTE_SESSION_ID: "" },
    BASE_URL,
  );
  assert.equal(ctx.sessionId, undefined);
});

// ---------------------------------------------------------------------------
// upstreamProxyBootstrapFromEnvMap — no-token / no-session (should-enable=false)
// ---------------------------------------------------------------------------

test("upstreamProxyBootstrapFromEnvMap: missing session + token → shouldEnable false", () => {
  const env = {
    REMOTE_ENABLED: "1",
    CCR_UPSTREAM_PROXY_ENABLED: "true",
  };
  const b = upstreamProxyBootstrapFromEnvMap(env, BASE_URL);
  assert.equal(bootstrapShouldEnable(b), false);
  assert.equal(bootstrapStateForPort(b, 8080, NO_PROXY).enabled, false);
});

test("upstreamProxyBootstrapFromEnvMap: remote disabled → shouldEnable false", () => {
  const dir = makeTempDir();
  const tokenPath = join(dir, "token");
  writeFileSync(tokenPath, "secret");

  const env = {
    REMOTE_ENABLED: "0",
    CCR_UPSTREAM_PROXY_ENABLED: "true",
    REMOTE_SESSION_ID: "sess-1",
    CCR_SESSION_TOKEN_PATH: tokenPath,
  };
  const b = upstreamProxyBootstrapFromEnvMap(env, BASE_URL);
  assert.equal(bootstrapShouldEnable(b), false);
  rmSync(dir, { recursive: true });
});

test("upstreamProxyBootstrapFromEnvMap: proxy not enabled → shouldEnable false", () => {
  const dir = makeTempDir();
  const tokenPath = join(dir, "token");
  writeFileSync(tokenPath, "secret");

  const env = {
    REMOTE_ENABLED: "1",
    CCR_UPSTREAM_PROXY_ENABLED: "false",
    REMOTE_SESSION_ID: "sess-1",
    CCR_SESSION_TOKEN_PATH: tokenPath,
  };
  const b = upstreamProxyBootstrapFromEnvMap(env, BASE_URL);
  assert.equal(bootstrapShouldEnable(b), false);
  rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// upstreamProxyBootstrapFromEnvMap — full happy path
// ---------------------------------------------------------------------------

test("upstreamProxyBootstrapFromEnvMap: all conditions met → shouldEnable true", () => {
  const dir = makeTempDir();
  const tokenPath = join(dir, "token");
  const caBundlePath = join(dir, "ca-bundle.crt");
  writeFileSync(tokenPath, "  secret-token\n");

  const env = {
    REMOTE_ENABLED: "1",
    CCR_UPSTREAM_PROXY_ENABLED: "true",
    REMOTE_SESSION_ID: "session-123",
    REMOTE_BASE_URL: "https://remote.test",
    CCR_SESSION_TOKEN_PATH: tokenPath,
    CCR_CA_BUNDLE_PATH: caBundlePath,
  };
  const b = upstreamProxyBootstrapFromEnvMap(env, BASE_URL);

  assert.equal(bootstrapShouldEnable(b), true);
  assert.equal(b.token, "secret-token"); // trimmed
  assert.equal(bootstrapWsUrl(b), "wss://remote.test/v1/code/upstreamproxy/ws");

  const state = bootstrapStateForPort(b, 9443, NO_PROXY);
  assert.equal(state.enabled, true);
  assert.equal(state.proxyUrl, "http://127.0.0.1:9443");
  assert.equal(state.caBundlePath, caBundlePath);
  assert.equal(state.noProxy, NO_PROXY);

  const subEnv = proxyStateSubprocessEnv(state);
  assert.equal(subEnv["HTTPS_PROXY"], "http://127.0.0.1:9443");
  assert.equal(subEnv["https_proxy"], "http://127.0.0.1:9443");
  assert.equal(subEnv["SSL_CERT_FILE"], caBundlePath);
  assert.equal(subEnv["NODE_EXTRA_CA_CERTS"], caBundlePath);
  assert.equal(subEnv["REQUESTS_CA_BUNDLE"], caBundlePath);
  assert.equal(subEnv["CURL_CA_BUNDLE"], caBundlePath);
  assert.equal(subEnv["NO_PROXY"], NO_PROXY);
  assert.equal(subEnv["no_proxy"], NO_PROXY);

  rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// disabledProxyState / proxyStateSubprocessEnv
// ---------------------------------------------------------------------------

test("disabledProxyState: subprocess env is empty", () => {
  const state = disabledProxyState(NO_PROXY);
  assert.equal(state.enabled, false);
  const env = proxyStateSubprocessEnv(state);
  assert.deepEqual(env, {});
});

test("proxyStateSubprocessEnv: missing proxyUrl → empty", () => {
  const state = {
    enabled: true,
    proxyUrl: undefined,
    caBundlePath: "/ca.crt",
    noProxy: NO_PROXY,
  };
  assert.deepEqual(proxyStateSubprocessEnv(state), {});
});

test("proxyStateSubprocessEnv: missing caBundlePath → empty", () => {
  const state = {
    enabled: true,
    proxyUrl: "http://127.0.0.1:8080",
    caBundlePath: undefined,
    noProxy: NO_PROXY,
  };
  assert.deepEqual(proxyStateSubprocessEnv(state), {});
});

// ---------------------------------------------------------------------------
// upstreamProxyWsUrl
// ---------------------------------------------------------------------------

test("upstreamProxyWsUrl: https → wss", () => {
  assert.equal(
    upstreamProxyWsUrl("https://remote.test"),
    "wss://remote.test/v1/code/upstreamproxy/ws",
  );
});

test("upstreamProxyWsUrl: http → ws", () => {
  assert.equal(
    upstreamProxyWsUrl("http://localhost:3000/"),
    "ws://localhost:3000/v1/code/upstreamproxy/ws",
  );
});

test("upstreamProxyWsUrl: trailing slashes stripped", () => {
  assert.equal(
    upstreamProxyWsUrl("https://remote.test///"),
    "wss://remote.test/v1/code/upstreamproxy/ws",
  );
});

test("upstreamProxyWsUrl: no scheme → wss prefix assumed", () => {
  assert.equal(
    upstreamProxyWsUrl("remote.test"),
    "wss://remote.test/v1/code/upstreamproxy/ws",
  );
});

// ---------------------------------------------------------------------------
// inheritedUpstreamProxyEnv
// ---------------------------------------------------------------------------

test("inheritedUpstreamProxyEnv: both HTTPS_PROXY + SSL_CERT_FILE present → subset returned", () => {
  const env = {
    HTTPS_PROXY: "http://127.0.0.1:8888",
    SSL_CERT_FILE: "/tmp/ca.crt",
    NO_PROXY: "localhost",
    SOME_OTHER: "ignored",
  };
  const inherited = inheritedUpstreamProxyEnv(env);
  assert.equal(inherited["HTTPS_PROXY"], "http://127.0.0.1:8888");
  assert.equal(inherited["SSL_CERT_FILE"], "/tmp/ca.crt");
  assert.equal(inherited["NO_PROXY"], "localhost");
  assert.equal(inherited["SOME_OTHER"], undefined);
});

test("inheritedUpstreamProxyEnv: missing SSL_CERT_FILE → empty", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:8888" };
  assert.deepEqual(inheritedUpstreamProxyEnv(env), {});
});

test("inheritedUpstreamProxyEnv: missing HTTPS_PROXY → empty", () => {
  const env = { SSL_CERT_FILE: "/tmp/ca.crt" };
  assert.deepEqual(inheritedUpstreamProxyEnv(env), {});
});

test("inheritedUpstreamProxyEnv: empty env → empty", () => {
  assert.deepEqual(inheritedUpstreamProxyEnv({}), {});
});

// ---------------------------------------------------------------------------
// readToken
// ---------------------------------------------------------------------------

test("readToken: trims whitespace and newlines", () => {
  const dir = makeTempDir();
  const path = join(dir, "token");
  writeFileSync(path, " abc123 \n");
  assert.equal(readToken(path), "abc123");
  rmSync(dir, { recursive: true });
});

test("readToken: absent file → undefined", () => {
  const result = readToken("/no/such/file/at/all.token");
  assert.equal(result, undefined);
});

test("readToken: empty file → undefined", () => {
  const dir = makeTempDir();
  const path = join(dir, "empty");
  writeFileSync(path, "   \n");
  assert.equal(readToken(path), undefined);
  rmSync(dir, { recursive: true });
});
