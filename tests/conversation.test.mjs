import assert from "node:assert/strict";
import test from "node:test";

import { ConversationRuntime } from "../dist/runtime/conversation.js";
import { PermissionEnforcer } from "../dist/runtime/permission-enforcer.js";
import { SystemPromptBuilder } from "../dist/runtime/prompt.js";
import { GlobalToolRegistry } from "../dist/tools/registry.js";

function toolCall(name, args, id = "call-test") {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

function createMemorySessionStore() {
  let nextId = 0;
  return {
    async create(options) {
      nextId += 1;
      return {
        id: `session-${nextId}`,
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
        status: "running",
        changedFiles: [],
        nextSteps: [],
        ...options,
      };
    },
    async complete(session, update) {
      return {
        ...session,
        updatedAt: "2026-05-23T00:00:01.000Z",
        status: "completed",
        summary: update.summary,
        changedFiles: update.changedFiles,
        nextSteps: update.nextSteps,
      };
    },
    async fail(session, error) {
      return {
        ...session,
        updatedAt: "2026-05-23T00:00:01.000Z",
        status: "failed",
        error,
      };
    },
  };
}

function createRuntime(apiClient, extra = {}) {
  return new ConversationRuntime({
    apiClient,
    toolRegistry: new GlobalToolRegistry(),
    sessionStore: createMemorySessionStore(),
    permissionEnforcer: new PermissionEnforcer({ approvalPolicy: "never", sandbox: "workspace-write" }),
    promptBuilder: new SystemPromptBuilder(),
    ...extra,
  });
}

test("ConversationRuntime preserves injected command approval callbacks", async () => {
  let approvalPrompted = false;
  const client = {
    async chat(options) {
      const lastToolMessage = options.messages.findLast?.((message) => message.role === "tool");
      if (lastToolMessage) {
        assert.doesNotMatch(lastToolMessage.content, /Command requires approval/);
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [toolCall("finish", { summary: "approved command", changed_files: [], next_steps: [] })],
            },
          }],
        };
      }

      return {
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("run_command", { command: "git push --version" })],
          },
        }],
      };
    },
  };

  const summary = await createRuntime(client, {
    permissionEnforcer: new PermissionEnforcer({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approveCommand: async () => {
        approvalPrompted = true;
        return true;
      },
    }),
  }).runTurn({
    goal: "run approved command",
    cwd: process.cwd(),
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });

  assert.equal(approvalPrompted, true);
  assert.equal(summary.finish.summary, "approved command");
});

test("ConversationRuntime completes a turn when finish is called", async () => {
  const client = {
    async chat(options) {
      assert.equal(options.toolChoice, "auto");
      assert.equal(options.reasoningEffort, "medium");
      assert.equal(options.model, "solar-test");
      assert.equal(options.tools.some((tool) => tool.function.name === "finish"), true);
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("finish", {
              summary: "done",
              changed_files: [],
              next_steps: [],
            })],
          },
        }],
      };
    },
  };

  const summary = await createRuntime(client).runTurn({
    goal: "explain the repository",
    cwd: process.cwd(),
    reasoningEffort: "medium",
    model: "solar-test",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  assert.equal(summary.session.status, "completed");
  assert.equal(summary.finish.summary, "done");
  assert.equal(summary.turns, 1);
});

test("ConversationRuntime returns invalid tool JSON as recoverable tool output", async () => {
  const seenToolMessages = [];
  const client = {
    async chat(options) {
      const lastToolMessage = options.messages.findLast?.((message) => message.role === "tool");
      if (lastToolMessage) {
        seenToolMessages.push(lastToolMessage.content);
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [toolCall("finish", { summary: "recovered", changed_files: [], next_steps: [] })],
            },
          }],
        };
      }

      return {
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("read_file", "{not-json")],
          },
        }],
      };
    },
  };

  const summary = await createRuntime(client).runTurn({
    goal: "inspect files",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  assert.match(seenToolMessages[0], /^ERROR: invalid JSON arguments:/);
  assert.equal(summary.finish.summary, "recovered");
  assert.equal(summary.turns, 2);
});

test("ConversationRuntime enforces read-only sandbox for hidden write tool calls", async () => {
  const seenToolMessages = [];
  const client = {
    async chat(options) {
      const lastToolMessage = options.messages.findLast?.((message) => message.role === "tool");
      if (lastToolMessage) {
        seenToolMessages.push(lastToolMessage.content);
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [toolCall("finish", { summary: "blocked write", changed_files: [], next_steps: [] })],
            },
          }],
        };
      }

      assert.equal(options.tools.some((tool) => tool.function.name === "write_file"), false);
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("write_file", { path: "a.txt", content: "nope" })],
          },
        }],
      };
    },
  };

  const summary = await createRuntime(client).runTurn({
    goal: "inspect files",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });

  assert.equal(seenToolMessages[0], "ERROR: write_file is disabled in read-only sandbox mode.");
  assert.equal(summary.finish.summary, "blocked write");
});

test("ConversationRuntime compacts without dangling tool-call messages", async () => {
  let callCount = 0;
  const client = {
    async chat(options) {
      callCount += 1;

      if (callCount === 2) {
        assert.equal(options.messages.some((message) => message.role === "tool"), false);
        assert.equal(options.messages.some((message) => message.role === "assistant" && message.tool_calls?.length), false);
        assert.equal(options.messages.some((message) => message.content?.includes("Earlier tool transcript was compacted")), true);
      }

      return {
        choices: [{
          message: callCount === 1
            ? {
                role: "assistant",
                content: "",
                tool_calls: [toolCall("read_file", { path: "missing.txt" })],
              }
            : {
                role: "assistant",
                content: "",
                tool_calls: [toolCall("finish", { summary: "compacted", changed_files: [], next_steps: [] })],
              },
        }],
      };
    },
  };

  const summary = await createRuntime(client, { maxTranscriptTokens: 1 }).runTurn({
    goal: "inspect files",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  assert.equal(summary.finish.summary, "compacted");
  assert.equal(callCount, 2);
});

test("ConversationRuntime enforces max turn guard", async () => {
  const client = {
    async chat() {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "I need to continue without tools.",
          },
        }],
      };
    },
  };

  await assert.rejects(
    () => createRuntime(client).runTurn({
      goal: "never finish",
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "workspace-write",
      maxTurns: 2,
    }),
    /exceeded maxTurns/,
  );
});
