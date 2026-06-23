import assert from "node:assert/strict";
import test from "node:test";

import { ConversationRuntime } from "../dist/runtime/conversation.js";
import { HookRunner } from "../dist/runtime/hooks.js";
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
    // Keep the suite hermetic: never spawn a real `git` subprocess.
    gitContextProvider: async () => undefined,
    ...extra,
  });
}

const FINISH_RESPONSE = {
  choices: [{
    message: {
      role: "assistant",
      content: "stream",
      tool_calls: [toolCall("finish", { summary: "streamed done", changed_files: [], next_steps: [] })],
    },
  }],
};

function streamingClient(response = FINISH_RESPONSE, deltas = ["str", "eam"]) {
  return {
    async chat() {
      return response;
    },
    async *chatStream() {
      for (const text of deltas) yield { type: "delta", text };
      yield { type: "done", response };
    },
  };
}

test("ConversationRuntime streams deltas and completes via chatStream", async () => {
  const deltas = [];
  const summary = await createRuntime(streamingClient()).runTurn({
    goal: "show me",
    cwd: process.cwd(),
    stream: true,
    onDelta: (text) => deltas.push(text),
  });
  assert.equal(summary.finish.summary, "streamed done");
  assert.deepEqual(deltas, ["str", "eam"]);
});

test("ConversationRuntime streaming and buffered paths reach the same finish", async () => {
  const streamed = await createRuntime(streamingClient()).runTurn({ goal: "go", cwd: process.cwd(), stream: true });
  const buffered = await createRuntime(streamingClient()).runTurn({ goal: "go", cwd: process.cwd(), stream: false });
  assert.equal(streamed.finish.summary, buffered.finish.summary);
});

test("ConversationRuntime falls back to chat when streaming is requested but unsupported", async () => {
  const client = { async chat() { return FINISH_RESPONSE; } };
  const summary = await createRuntime(client).runTurn({ goal: "go", cwd: process.cwd(), stream: true });
  assert.equal(summary.finish.summary, "streamed done");
});

test("ConversationRuntime PreToolUse hook can block a tool call", async () => {
  let blockedToolContent;
  const client = {
    async chat(options) {
      const lastTool = options.messages.findLast?.((m) => m.role === "tool");
      if (lastTool) {
        blockedToolContent = lastTool.content;
        return {
          choices: [{
            message: { role: "assistant", content: "", tool_calls: [toolCall("finish", { summary: "done", changed_files: [], next_steps: [] })] },
          }],
        };
      }
      return {
        choices: [{
          message: { role: "assistant", content: "", tool_calls: [toolCall("read_file", { path: "secret.txt" })] },
        }],
      };
    },
  };
  // A hook that denies only read_file (exit 2); other tools (e.g. finish) pass.
  const denyExecutor = async (_command, env) =>
    env.HOOK_TOOL_NAME === "read_file"
      ? { exitCode: 2, stdout: "no reads allowed", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
  const hookRunner = new HookRunner({ preToolUse: ["deny.sh"] }, denyExecutor);

  const summary = await createRuntime(client, { hookRunner }).runTurn({
    goal: "look at the file",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  assert.equal(summary.finish.summary, "done");
  assert.match(blockedToolContent, /blocked by PreToolUse hook/);
  assert.match(blockedToolContent, /no reads allowed/);
});

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

test("ConversationRuntime compacts with an async model summary (structural)", async () => {
  let turnCalls = 0;
  let summaryCalls = 0;
  let compactedSeen = false;
  const client = {
    async chat(options) {
      if (options.messages[0]?.content?.includes("Summarize the following conversation segment")) {
        summaryCalls += 1;
        return { choices: [{ message: { role: "assistant", content: "- inspected a missing file" } }] };
      }

      turnCalls += 1;
      if (turnCalls === 2) {
        // The transcript was compacted before this turn: no dangling tool /
        // tool-call messages, exactly one inserted summary message after the
        // 2-message head, and the message count strictly dropped.
        assert.equal(options.messages.some((m) => m.role === "tool"), false);
        assert.equal(options.messages.some((m) => m.role === "assistant" && m.tool_calls?.length), false);
        assert.equal(options.messages[2].role, "user");
        assert.match(options.messages[2].content, /inspected a missing file/);
        assert.ok(options.messages.length < 4);
        compactedSeen = true;
      }

      return {
        choices: [{
          message: turnCalls === 1
            ? { role: "assistant", content: "", tool_calls: [toolCall("read_file", { path: "missing.txt" })] }
            : { role: "assistant", content: "", tool_calls: [toolCall("finish", { summary: "compacted", changed_files: [], next_steps: [] })] },
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
  assert.equal(summaryCalls, 1);
  assert.equal(compactedSeen, true);
});

test("ConversationRuntime compaction falls back to a notice when summarization fails", async () => {
  let turnCalls = 0;
  const client = {
    async chat(options) {
      if (options.messages[0]?.content?.includes("Summarize the following conversation segment")) {
        throw new Error("summary unavailable");
      }

      turnCalls += 1;
      if (turnCalls === 2) {
        assert.equal(
          options.messages.some((m) => m.content?.includes("Earlier tool transcript was compacted")),
          true,
        );
      }

      return {
        choices: [{
          message: turnCalls === 1
            ? { role: "assistant", content: "", tool_calls: [toolCall("read_file", { path: "missing.txt" })] }
            : { role: "assistant", content: "", tool_calls: [toolCall("finish", { summary: "ok", changed_files: [], next_steps: [] })] },
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

  assert.equal(summary.finish.summary, "ok");
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
