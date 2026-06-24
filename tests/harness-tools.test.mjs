import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeBuiltinTool } from "../dist/tools/executor.js";
import { GlobalToolRegistry } from "../dist/tools/registry.js";

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "solarcido-harness-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseContext(root, extra = {}) {
  return {
    root,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ...extra,
  };
}

test("ask_user_question with an interaction returns answered", async () => {
  await withTempRoot(async (root) => {
    const interaction = {
      askText: async () => "freeform",
      askYesNo: async () => true,
      askChoice: async (_q, options) => options[1],
    };

    const choice = await executeBuiltinTool(
      "ask_user_question",
      { question: "Pick one", options: ["a", "b"] },
      baseContext(root, { interaction }),
    );
    const choicePayload = JSON.parse(choice.content);
    assert.equal(choicePayload.status, "answered");
    assert.equal(choicePayload.answer, "b");

    const text = await executeBuiltinTool(
      "ask_user_question",
      { question: "Anything?" },
      baseContext(root, { interaction }),
    );
    const textPayload = JSON.parse(text.content);
    assert.equal(textPayload.status, "answered");
    assert.equal(textPayload.answer, "freeform");
  });
});

test("ask_user_question with no interaction is unanswered and does not throw", async () => {
  await withTempRoot(async (root) => {
    const result = await executeBuiltinTool(
      "ask_user_question",
      { question: "Still there?" },
      baseContext(root),
    );
    const payload = JSON.parse(result.content);
    assert.equal(payload.status, "unanswered");
    assert.equal(payload.answer, null);
    assert.match(payload.reason, /no interactive terminal/);
  });
});

test("plan mode blocks writes and exit_plan_mode re-enables them", async () => {
  await withTempRoot(async (root) => {
    const registry = new GlobalToolRegistry();
    const planMode = { active: false };
    const approving = {
      askText: async () => "",
      askYesNo: async () => true,
      askChoice: async (_q, options) => options[0],
    };
    const context = baseContext(root, { planMode, interaction: approving });

    const entered = await registry.execute("enter_plan_mode", {}, context);
    assert.equal(JSON.parse(entered.content).active, true);
    assert.equal(planMode.active, true);

    const blocked = await registry.execute(
      "write_file",
      { path: "blocked.txt", content: "no" },
      context,
    );
    assert.ok(blocked.content.startsWith("ERROR: plan mode is active"));
    assert.equal(existsSync(path.join(root, "blocked.txt")), false);

    const exited = await registry.execute("exit_plan_mode", { plan: "do the thing" }, context);
    const exitPayload = JSON.parse(exited.content);
    assert.equal(exitPayload.approved, true);
    assert.equal(planMode.active, false);

    const allowed = await registry.execute(
      "write_file",
      { path: "allowed.txt", content: "ok" },
      context,
    );
    assert.ok(!allowed.content.startsWith("ERROR:"));
    assert.equal(existsSync(path.join(root, "allowed.txt")), true);
  });
});

test("exit_plan_mode rejection keeps plan mode active", async () => {
  await withTempRoot(async (root) => {
    const registry = new GlobalToolRegistry();
    const planMode = { active: true };
    const rejecting = {
      askText: async () => "",
      askYesNo: async () => false,
      askChoice: async (_q, options) => options[0],
    };
    const context = baseContext(root, { planMode, interaction: rejecting });

    const exited = await registry.execute("exit_plan_mode", { plan: "nope" }, context);
    const payload = JSON.parse(exited.content);
    assert.equal(payload.approved, false);
    assert.equal(payload.active, true);
    assert.equal(planMode.active, true);
  });
});

test("todo_write persists todos and returns newTodos", async () => {
  await withTempRoot(async (root) => {
    const storePath = path.join(root, ".solarcido-todos.json");
    const todos = [
      { content: "First", activeForm: "Doing first", status: "in_progress" },
      { content: "Second", activeForm: "Doing second", status: "pending" },
    ];

    const result = await executeBuiltinTool("todo_write", { todos }, baseContext(root));
    const payload = JSON.parse(result.content);
    assert.deepEqual(payload.oldTodos, []);
    assert.deepEqual(payload.newTodos, todos);
    assert.equal(payload.verificationNudgeNeeded, undefined);

    assert.equal(existsSync(storePath), true);
    assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")), todos);
  });
});

test("todo_write all-completed clears store and nudges verification", async () => {
  await withTempRoot(async (root) => {
    const storePath = path.join(root, ".solarcido-todos.json");
    const todos = [
      { content: "Build module", activeForm: "Building module", status: "completed" },
      { content: "Wire runtime", activeForm: "Wiring runtime", status: "completed" },
      { content: "Update docs", activeForm: "Updating docs", status: "completed" },
    ];

    const result = await executeBuiltinTool("todo_write", { todos }, baseContext(root));
    const payload = JSON.parse(result.content);
    assert.deepEqual(payload.newTodos, []);
    assert.equal(payload.verificationNudgeNeeded, true);
    assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")), []);
  });
});

test("todo_write rejects invalid input", async () => {
  await withTempRoot(async (root) => {
    const empty = await executeBuiltinTool("todo_write", { todos: [] }, baseContext(root));
    assert.ok(empty.content.startsWith("ERROR:"));

    const badStatus = await executeBuiltinTool(
      "todo_write",
      { todos: [{ content: "x", activeForm: "x", status: "done" }] },
      baseContext(root),
    );
    assert.ok(badStatus.content.startsWith("ERROR:"));
  });
});
