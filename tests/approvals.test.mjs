import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyCommand } from "../dist/approvals/classify-command.js";
import { decideApproval } from "../dist/approvals/policy.js";
import { verifyExecution } from "../dist/agents/verifier.js";
import { createToolDefinitions, executeToolCall } from "../dist/tools/registry.js";

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

test("createToolDefinitions filters tools by maximum permission", () => {
  const readOnlyNames = createToolDefinitions({ maxPermission: "read-only" }).map((tool) => tool.function.name);
  const workspaceNames = createToolDefinitions({ maxPermission: "workspace-write" }).map((tool) => tool.function.name);

  assert.deepEqual(readOnlyNames, ["list_files", "read_file", "search_files", "finish"]);
  assert.equal(workspaceNames.includes("write_file"), true);
  assert.equal(workspaceNames.includes("edit_file"), true);
  assert.equal(workspaceNames.includes("run_command"), true);
});

test("executeToolCall enforces permission metadata for hidden tools", async () => {
  await withTempWorkspace(async (root) => {
    const result = await executeToolCall(root, toolCall("edit_file", {
      path: "a.txt",
      old_string: "old",
      new_string: "new",
    }), {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      maxPermission: "read-only",
    });

    assert.deepEqual(result, {
      toolName: "edit_file",
      content: "ERROR: edit_file is disabled in read-only sandbox mode.",
    });
  });
});

test("verifier exposes and enforces read-only tools only", async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, "a.txt"), "old", "utf8");
    const toolNamesByCall = [];
    const toolResults = [];
    const fakeClient = {
      async chat(options) {
        toolNamesByCall.push((options.tools ?? []).map((tool) => tool.function.name));

        const lastToolMessage = options.messages.findLast?.((message) => message.role === "tool");
        if (lastToolMessage) {
          toolResults.push(lastToolMessage.content);
        }

        if (toolResults.length === 0) {
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [toolCall("edit_file", {
                  path: "a.txt",
                  old_string: "old",
                  new_string: "new",
                })],
              },
            }],
          };
        }

        return {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [toolCall("finish", {
                summary: "verified",
                changed_files: [],
                next_steps: [],
              })],
            },
          }],
        };
      },
    };

    const result = await verifyExecution(
      fakeClient,
      "verify permissions",
      {
        summary: "permission plan",
        explorationTargets: [],
        executionSteps: [],
        verificationCommands: [],
      },
      {
        finish: {
          summary: "done",
          changed_files: [],
          next_steps: [],
        },
        transcript: [],
      },
      root,
    );

    assert.deepEqual(toolNamesByCall[0], ["list_files", "read_file", "search_files", "finish"]);
    assert.equal(toolResults[0], "ERROR: edit_file is disabled in read-only sandbox mode.");
    assert.equal(result.summary, "verified");
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
