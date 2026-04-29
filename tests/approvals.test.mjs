import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyCommand } from "../dist/approvals/classify-command.js";
import { decideApproval } from "../dist/approvals/policy.js";
import { executeToolCall } from "../dist/tools/registry.js";

function toolCall(name, args) {
  return {
    id: "call-test",
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

async function withTempWorkspace(run) {
  const root = await mkdtemp(path.join(tmpdir(), "solarcido-approval-test-"));

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("classifyCommand marks read commands as low risk", () => {
  assert.equal(classifyCommand("npm run build"), "low");
});

test("classifyCommand marks destructive or network commands as risky", () => {
  assert.equal(classifyCommand("git push origin main"), "risky");
  assert.equal(classifyCommand("Remove-Item -Recurse -Force dist"), "risky");
  assert.equal(classifyCommand("curl https://example.com"), "risky");
});

test("decideApproval allows low-risk commands for on-request", () => {
  assert.deepEqual(decideApproval("on-request", "low", undefined), {
    approved: true,
  });
});

test("decideApproval denies unapproved risky commands for on-request", () => {
  assert.deepEqual(decideApproval("on-request", "risky", false), {
    approved: false,
    reason: "Command requires approval.",
  });
});

test("executeToolCall blocks writes in read-only sandbox", async () => {
  await withTempWorkspace(async (root) => {
    const result = await executeToolCall(root, toolCall("write_file", { path: "a.txt", content: "hello" }), {
      approvalPolicy: "never",
      sandbox: "read-only",
    });

    assert.deepEqual(result, {
      toolName: "write_file",
      content: "ERROR: write_file is disabled in read-only sandbox mode.",
    });
  });
});

test("executeToolCall blocks unapproved risky commands for on-request policy", async () => {
  await withTempWorkspace(async (root) => {
    const result = await executeToolCall(root, toolCall("run_command", { command: "git push origin main" }), {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    assert.deepEqual(result, {
      toolName: "run_command",
      content: "ERROR: Command requires approval.",
    });
  });
});
