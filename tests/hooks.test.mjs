import assert from "node:assert/strict";
import test from "node:test";

import { HookRunner } from "../dist/runtime/hooks.js";

function mockExec(map) {
  const calls = [];
  const exec = async (command, env, stdin) => {
    calls.push({ command, env, stdin });
    return map[command] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("empty config allows with no messages", async () => {
  const result = await new HookRunner({}, async () => ({ exitCode: 0, stdout: "", stderr: "" })).runPreToolUse(
    "Read",
    "{}",
  );
  assert.equal(result.denied, false);
  assert.equal(result.failed, false);
  assert.deepEqual(result.messages, []);
});

test("exit 0 allows and captures stdout message", async () => {
  const { exec } = mockExec({ "pre.sh": { exitCode: 0, stdout: "pre ok", stderr: "" } });
  const result = await new HookRunner({ preToolUse: ["pre.sh"] }, exec).runPreToolUse("Read", '{"path":"README.md"}');
  assert.equal(result.denied, false);
  assert.deepEqual(result.messages, ["pre ok"]);
});

test("exit 2 denies", async () => {
  const { exec } = mockExec({ "block.sh": { exitCode: 2, stdout: "blocked by hook", stderr: "" } });
  const result = await new HookRunner({ preToolUse: ["block.sh"] }, exec).runPreToolUse("Bash", '{"command":"pwd"}');
  assert.equal(result.denied, true);
  assert.deepEqual(result.messages, ["blocked by hook"]);
});

test("non-zero/non-two exit fails", async () => {
  const { exec } = mockExec({ "warn.sh": { exitCode: 1, stdout: "warning hook", stderr: "" } });
  const result = await new HookRunner({ preToolUse: ["warn.sh"] }, exec).runPreToolUse("Edit", "{}");
  assert.equal(result.failed, true);
  assert.ok(result.messages.some((m) => m.includes("warning hook")));
});

test("parses JSON permission override + updatedInput", async () => {
  const stdout = JSON.stringify({
    systemMessage: "updated",
    hookSpecificOutput: {
      permissionDecision: "allow",
      permissionDecisionReason: "hook ok",
      updatedInput: { command: "git status" },
    },
  });
  const { exec } = mockExec({ "perm.sh": { exitCode: 0, stdout, stderr: "" } });
  const result = await new HookRunner({ preToolUse: ["perm.sh"] }, exec).runPreToolUse("bash", '{"command":"pwd"}');
  assert.equal(result.permissionDecision, "allow");
  assert.equal(result.permissionReason, "hook ok");
  assert.equal(result.updatedInput, '{"command":"git status"}');
  assert.ok(result.messages.includes("updated"));
});

test("decision:block denies", async () => {
  const { exec } = mockExec({ "b.sh": { exitCode: 0, stdout: '{"decision":"block","reason":"nope"}', stderr: "" } });
  const result = await new HookRunner({ preToolUse: ["b.sh"] }, exec).runPreToolUse("Edit", "{}");
  assert.equal(result.denied, true);
  assert.ok(result.messages.includes("nope"));
});

test("post-tool-use-failure hooks run", async () => {
  const { exec } = mockExec({ "f.sh": { exitCode: 0, stdout: "failure hook ran", stderr: "" } });
  const result = await new HookRunner({ postToolUseFailure: ["f.sh"] }, exec).runPostToolUseFailure(
    "bash",
    '{"command":"false"}',
    "command failed",
  );
  assert.equal(result.denied, false);
  assert.deepEqual(result.messages, ["failure hook ran"]);
});

test("stops running hooks after a failure", async () => {
  const { exec, calls } = mockExec({
    "broken.sh": { exitCode: 1, stdout: "broken", stderr: "" },
    "later.sh": { exitCode: 0, stdout: "later", stderr: "" },
  });
  const result = await new HookRunner({ preToolUse: ["broken.sh", "later.sh"] }, exec).runPreToolUse("Edit", "{}");
  assert.equal(result.failed, true);
  assert.ok(result.messages.some((m) => m.includes("broken")));
  assert.ok(!result.messages.includes("later"));
  assert.deepEqual(calls.map((c) => c.command), ["broken.sh"]);
});

test("executes hooks in configured order", async () => {
  const { exec, calls } = mockExec({
    "first.sh": { exitCode: 0, stdout: "first", stderr: "" },
    "second.sh": { exitCode: 0, stdout: "second", stderr: "" },
  });
  const result = await new HookRunner({ preToolUse: ["first.sh", "second.sh"] }, exec).runPreToolUse("Read", "{}");
  assert.deepEqual(result.messages, ["first", "second"]);
  assert.deepEqual(calls.map((c) => c.command), ["first.sh", "second.sh"]);
});

test("malformed JSON output reports a diagnostic", async () => {
  const { exec } = mockExec({ "bad.sh": { exitCode: 1, stdout: "{not-json", stderr: "stderr warning" } });
  const result = await new HookRunner({ preToolUse: ["bad.sh"] }, exec).runPreToolUse("Edit", "{}");
  assert.equal(result.failed, true);
  const rendered = result.messages.join("\n");
  assert.ok(rendered.includes("hook_invalid_json:"));
  assert.ok(rendered.includes("phase=PreToolUse"));
  assert.ok(rendered.includes("tool=Edit"));
});

test("passes HOOK_* env and a JSON payload on stdin", async () => {
  const { exec, calls } = mockExec({ "env.sh": { exitCode: 0, stdout: "", stderr: "" } });
  await new HookRunner({ preToolUse: ["env.sh"] }, exec).runPreToolUse("Read", '{"path":"a"}');
  assert.equal(calls[0].env.HOOK_EVENT, "PreToolUse");
  assert.equal(calls[0].env.HOOK_TOOL_NAME, "Read");
  const payload = JSON.parse(calls[0].stdin);
  assert.equal(payload.hook_event_name, "PreToolUse");
  assert.deepEqual(payload.tool_input, { path: "a" });
});
