import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyCommand } from "../dist/approvals/classify-command.js";
import { decideApproval } from "../dist/approvals/policy.js";
import { PermissionEnforcer } from "../dist/runtime/permission-enforcer.js";
import { verifyExecution } from "../dist/agents/verifier.js";
import { GlobalToolRegistry, createToolDefinitions, executeToolCall } from "../dist/tools/registry.js";

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

test("PermissionEnforcer decides tool permissions from sandbox policy", () => {
  const enforcer = new PermissionEnforcer({
    approvalPolicy: "never",
    sandbox: "read-only",
  });

  assert.deepEqual(enforcer.decideTool("read-only", "read_file"), { approved: true });
  assert.deepEqual(enforcer.decideTool("workspace-write", "write_file"), {
    approved: false,
    reason: "write_file is disabled in read-only sandbox mode.",
  });
});

test("PermissionEnforcer preserves command approval policy decisions", async () => {
  const denied = new PermissionEnforcer({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approveCommand: async () => false,
  });
  const approved = new PermissionEnforcer({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approveCommand: async () => true,
  });

  assert.deepEqual(await denied.decideCommand("git push origin main"), {
    approved: false,
    reason: "Command requires approval.",
  });
  assert.deepEqual(await approved.decideCommand("git push origin main"), { approved: true });
  assert.deepEqual(await denied.decideCommand("npm run build"), { approved: true });
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

  assert.deepEqual(readOnlyNames, ["list_files", "read_file", "search_files", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "todo_write", "finish"]);
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

    assert.deepEqual(toolNamesByCall[0], ["list_files", "read_file", "search_files", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "todo_write", "finish"]);
    assert.equal(toolResults[0], "ERROR: edit_file is disabled in read-only sandbox mode.");
    assert.equal(result.summary, "verified");
  });
});

test("GlobalToolRegistry supports normalized allowed tool filtering", () => {
  const registry = new GlobalToolRegistry();

  const names = registry.definitions({
    allowedTools: new Set(["bash", "grep-search", "finish"]),
    maxPermission: "workspace-write",
  }).map((tool) => tool.function.name);

  assert.deepEqual(names, ["search_files", "run_command", "finish"]);
  assert.deepEqual(registry.permissionSpecs({ allowedTools: new Set(["bash"]) }), [["run_command", "workspace-write"]]);
});

test("GlobalToolRegistry returns structured errors for unknown tools", async () => {
  await withTempWorkspace(async (root) => {
    const registry = new GlobalToolRegistry();
    const result = await registry.execute("missing_tool", {}, {
      root,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });

    assert.deepEqual(result, {
      toolName: "missing_tool",
      content: "ERROR: unsupported tool: missing_tool",
    });
  });
});

test("executeToolCall keeps edit ambiguity as a structured tool error", async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, "a.txt"), "same same", "utf8");

    const result = await executeToolCall(root, toolCall("edit_file", {
      path: "a.txt",
      old_string: "same",
      new_string: "other",
    }), {
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });

    assert.deepEqual(result, {
      toolName: "edit_file",
      content: "ERROR: old_string appears 2 times in a.txt; set replace_all true or provide more context.",
    });
  });
});

test("executeToolCall keeps command output structured", async () => {
  await withTempWorkspace(async (root) => {
    const result = await executeToolCall(root, toolCall("run_command", {
      command: "node -e \"console.log('ok')\"",
    }), {
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });

    assert.equal(result.toolName, "run_command");
    assert.match(result.content, /exit_code:/);
    assert.match(result.content, /stdout:\s*ok/);
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

test("GlobalToolRegistry uses injected PermissionEnforcer for risky command approval", async () => {
  await withTempWorkspace(async (root) => {
    const registry = new GlobalToolRegistry();
    const result = await registry.execute("run_command", {
      command: "npm install --version",
    }, {
      root,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      permissionEnforcer: new PermissionEnforcer({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approveCommand: async () => true,
      }),
    });

    assert.equal(result.toolName, "run_command");
    assert.match(result.content, /exit_code:/);
    assert.doesNotMatch(result.content, /Command requires approval/);
  });
});
