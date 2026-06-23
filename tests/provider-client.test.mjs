import assert from "node:assert/strict";
import test from "node:test";

import { createApiClientForModel } from "../dist/api/client.js";

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("routes Solar / unknown models to the Upstage client", () => {
  withEnv({ UPSTAGE_API_KEY: "test-key" }, () => {
    const solar = createApiClientForModel("solar-pro3-260323");
    assert.equal(typeof solar.chat, "function");
    const unknown = createApiClientForModel("some-unknown-model");
    assert.equal(typeof unknown.chat, "function");
  });
});

test("routes grok-* to xAI and requires XAI_API_KEY", () => {
  withEnv({ XAI_API_KEY: undefined }, () => {
    assert.throws(() => createApiClientForModel("grok-3"), /XAI_API_KEY is required/);
  });
  withEnv({ XAI_API_KEY: "x-key" }, () => {
    const client = createApiClientForModel("grok-3");
    assert.equal(typeof client.chat, "function");
    assert.equal(typeof client.chatStream, "function");
  });
});

test("routes gpt-* to OpenAI and requires OPENAI_API_KEY", () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.throws(() => createApiClientForModel("gpt-4o"), /OPENAI_API_KEY is required/);
  });
  withEnv({ OPENAI_API_KEY: "o-key" }, () => {
    assert.equal(typeof createApiClientForModel("gpt-4o").chat, "function");
  });
});

test("routes kimi-* to DashScope and requires DASHSCOPE_API_KEY", () => {
  withEnv({ DASHSCOPE_API_KEY: "d-key" }, () => {
    assert.equal(typeof createApiClientForModel("kimi-k2.5").chat, "function");
  });
});
