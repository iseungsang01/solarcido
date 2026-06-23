import assert from "node:assert/strict";
import test from "node:test";

import { parseHookConfig, mergeHookConfigs } from "../dist/runtime/hooks-config.js";

test("parseHookConfig reads a flat config", () => {
  const config = parseHookConfig(JSON.stringify({ preToolUse: ["a"], postToolUse: ["b"], postToolUseFailure: ["c"] }));
  assert.deepEqual(config, { preToolUse: ["a"], postToolUse: ["b"], postToolUseFailure: ["c"] });
});

test("parseHookConfig reads a {hooks:{…}} wrapper and PascalCase keys", () => {
  const config = parseHookConfig(JSON.stringify({ hooks: { PreToolUse: ["x"], PostToolUse: ["y"] } }));
  assert.deepEqual(config.preToolUse, ["x"]);
  assert.deepEqual(config.postToolUse, ["y"]);
  assert.deepEqual(config.postToolUseFailure, []);
});

test("parseHookConfig returns empty on malformed JSON or non-array entries", () => {
  assert.deepEqual(parseHookConfig("not json"), { preToolUse: [], postToolUse: [], postToolUseFailure: [] });
  const config = parseHookConfig(JSON.stringify({ preToolUse: "oops" }));
  assert.deepEqual(config.preToolUse, []);
});

test("mergeHookConfigs concatenates each phase", () => {
  const merged = mergeHookConfigs(
    { preToolUse: ["a"], postToolUse: [], postToolUseFailure: [] },
    { preToolUse: ["b"], postToolUse: ["c"], postToolUseFailure: [] },
  );
  assert.deepEqual(merged.preToolUse, ["a", "b"]);
  assert.deepEqual(merged.postToolUse, ["c"]);
});
