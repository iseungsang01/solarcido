import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskScope,
  taskScopeLabel,
  ValidatedPacket,
  TaskPacketValidationError,
  validatePacket,
} from "../dist/runtime/task-packet.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function samplePacket() {
  return {
    objective: "Implement typed task packet format",
    scope: TaskScope.Module,
    scopePath: "runtime/task system",
    repo: "solarcido",
    worktree: "/tmp/wt-1",
    branchPolicy: "origin/main only",
    acceptanceTests: ["npm run build", "npm test"],
    commitPolicy: "single verified commit",
    reportingContract: "print build result, test result, commit sha",
    escalationPolicy: "stop only on destructive ambiguity",
  };
}

// ---------------------------------------------------------------------------
// TaskScope label
// ---------------------------------------------------------------------------

test("taskScopeLabel: workspace", () => {
  assert.equal(taskScopeLabel(TaskScope.Workspace), "workspace");
});

test("taskScopeLabel: module", () => {
  assert.equal(taskScopeLabel(TaskScope.Module), "module");
});

test("taskScopeLabel: single-file", () => {
  assert.equal(taskScopeLabel(TaskScope.SingleFile), "single-file");
});

test("taskScopeLabel: custom", () => {
  assert.equal(taskScopeLabel(TaskScope.Custom), "custom");
});

// ---------------------------------------------------------------------------
// validatePacket — success path
// ---------------------------------------------------------------------------

test("validatePacket: valid packet returns ValidatedPacket", () => {
  const packet = samplePacket();
  const validated = validatePacket(packet);
  assert.ok(validated instanceof ValidatedPacket);
});

test("validatePacket: packet() returns original packet reference", () => {
  const packet = samplePacket();
  const validated = validatePacket(packet);
  assert.deepEqual(validated.packet(), packet);
});

test("validatePacket: intoInner() returns original packet reference", () => {
  const packet = samplePacket();
  const validated = validatePacket(packet);
  assert.deepEqual(validated.intoInner(), packet);
});

test("validatePacket: workspace scope with no scopePath is valid", () => {
  const packet = { ...samplePacket(), scope: TaskScope.Workspace, scopePath: undefined };
  assert.doesNotThrow(() => validatePacket(packet));
});

test("validatePacket: empty acceptanceTests array is valid", () => {
  const packet = { ...samplePacket(), acceptanceTests: [] };
  assert.doesNotThrow(() => validatePacket(packet));
});

// ---------------------------------------------------------------------------
// validatePacket — failure path (error accumulation)
// ---------------------------------------------------------------------------

test("validatePacket: throws TaskPacketValidationError on failure", () => {
  const packet = {
    objective: " ",
    scope: TaskScope.Workspace,
    scopePath: undefined,
    repo: "",
    worktree: undefined,
    branchPolicy: "\t",
    acceptanceTests: ["ok", " "],
    commitPolicy: "",
    reportingContract: "",
    escalationPolicy: "",
  };

  assert.throws(
    () => validatePacket(packet),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      assert.ok(err.errors.length >= 7);
      assert.ok(err.errors.includes("objective must not be empty"));
      assert.ok(err.errors.includes("repo must not be empty"));
      assert.ok(err.errors.includes("acceptance_tests contains an empty value at index 1"));
      return true;
    },
  );
});

test("validatePacket: module scope without scopePath is an error", () => {
  const packet = { ...samplePacket(), scope: TaskScope.Module, scopePath: undefined };
  assert.throws(
    () => validatePacket(packet),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      assert.ok(err.errors.some((e) => e.includes("scope_path is required")));
      assert.ok(err.errors.some((e) => e.includes("module")));
      return true;
    },
  );
});

test("validatePacket: single-file scope without scopePath is an error", () => {
  const packet = { ...samplePacket(), scope: TaskScope.SingleFile, scopePath: undefined };
  assert.throws(
    () => validatePacket(packet),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      assert.ok(err.errors.some((e) => e.includes("single-file")));
      return true;
    },
  );
});

test("validatePacket: custom scope without scopePath is an error", () => {
  const packet = { ...samplePacket(), scope: TaskScope.Custom, scopePath: undefined };
  assert.throws(
    () => validatePacket(packet),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      assert.ok(err.errors.some((e) => e.includes("custom")));
      return true;
    },
  );
});

test("validatePacket: module scope with blank scopePath is an error", () => {
  const packet = { ...samplePacket(), scope: TaskScope.Module, scopePath: "   " };
  assert.throws(
    () => validatePacket(packet),
    (err) => {
      assert.ok(err instanceof TaskPacketValidationError);
      return true;
    },
  );
});

test("TaskPacketValidationError: message joins errors with semicolon", () => {
  const packet = { ...samplePacket(), objective: "", repo: "" };
  try {
    validatePacket(packet);
    assert.fail("expected error");
  } catch (err) {
    assert.ok(err instanceof TaskPacketValidationError);
    assert.ok(err.message.includes(";"));
  }
});
