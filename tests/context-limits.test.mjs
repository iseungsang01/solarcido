import assert from "node:assert/strict";
import test from "node:test";

import { clampText } from "../dist/runtime/output-limits.js";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../dist/workflow/context-budget.js";

test("clampText leaves text within the cap untouched", () => {
  assert.equal(clampText("hello world", 100), "hello world");
});

test("clampText head mode truncates and marks the omission", () => {
  const text = "a".repeat(1000);
  const out = clampText(text, 100, "head");
  assert.ok(out.startsWith("a".repeat(100)));
  assert.match(out, /\d+ characters truncated/);
  assert.ok(out.length < text.length);
});

test("clampText head-tail mode preserves both the start and the end", () => {
  const text = "S".repeat(500) + "E".repeat(500);
  const out = clampText(text, 100, "head-tail");
  assert.ok(out.startsWith("S"));
  assert.ok(out.endsWith("E"));
  assert.match(out, /characters truncated/);
});

test("estimateTokens counts CJK characters denser than ASCII", () => {
  // The old uniform chars/4 rule under-counted Korean ~2x; CJK must weigh more.
  assert.ok(estimateTokens("가".repeat(100)) > estimateTokens("a".repeat(100)));
});

test("estimateMessageTokens counts tool-call arguments, not only content", () => {
  const bigArgs = JSON.stringify({ path: "a.ts", content: "x".repeat(4000) });
  const withToolCall = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: bigArgs } }],
  };
  const contentOnly = { role: "assistant", content: "" };

  // The big write_file body lives in tool_calls; the estimate must reflect it.
  assert.ok(estimateMessageTokens(withToolCall) > estimateMessageTokens(contentOnly) + 500);
  assert.ok(estimateMessagesTokens([withToolCall]) > 900);
});
