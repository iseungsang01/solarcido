import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedPrematureFinishMessage,
  goalLikelyRequiresModification,
  isSuccessfulModificationTool,
} from "../dist/agents/execution-guard.js";

test("goalLikelyRequiresModification detects English change requests", () => {
  assert.equal(goalLikelyRequiresModification("fix the parser bug"), true);
  assert.equal(goalLikelyRequiresModification("update README examples"), true);
  assert.equal(goalLikelyRequiresModification("show the current files"), false);
});

test("goalLikelyRequiresModification detects Korean change requests", () => {
  assert.equal(goalLikelyRequiresModification("코드 수정까지 하도록 만들어줘"), true);
  assert.equal(goalLikelyRequiresModification("현재 구조만 설명해줘"), false);
});

test("isSuccessfulModificationTool only accepts successful write tools", () => {
  assert.equal(isSuccessfulModificationTool("edit_file", "Edited src/index.ts (1 replacement)"), true);
  assert.equal(isSuccessfulModificationTool("write_file", "Wrote src/new.ts"), true);
  assert.equal(isSuccessfulModificationTool("edit_file", "ERROR: Could not find old_string."), false);
  assert.equal(isSuccessfulModificationTool("read_file", "content"), false);
});

test("blockedPrematureFinishMessage returns a recoverable tool error", () => {
  assert.match(blockedPrematureFinishMessage(), /^ERROR:/);
});

