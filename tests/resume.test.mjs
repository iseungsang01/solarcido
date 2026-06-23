import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  completeSession,
  createSession,
  loadSessionForResume,
} from "../dist/runtime/session.js";

async function withSessionHome(run) {
  const previousHome = process.env.SOLARCIDO_HOME;
  const home = await mkdtemp(path.join(tmpdir(), "solarcido-resume-test-"));
  process.env.SOLARCIDO_HOME = home;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.SOLARCIDO_HOME;
    else process.env.SOLARCIDO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

const baseOptions = {
  goal: "do X",
  cwd: process.cwd(),
  model: "solar-test",
  reasoningEffort: "medium",
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
};

const sampleMessages = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "Goal: do X" },
  { role: "assistant", content: "working on it", tool_calls: [] },
  { role: "tool", tool_call_id: "t1", content: "tool result" },
];

test("completeSession persists the transcript and it round-trips via loadSessionForResume", async () => {
  await withSessionHome(async () => {
    const created = await createSession(baseOptions);
    const completed = await completeSession(created, {
      summary: "done",
      changedFiles: [],
      nextSteps: [],
      messages: sampleMessages,
    });

    const loaded = await loadSessionForResume(created.id);
    // Concrete round-trip invariant: identical length, roles, and contents.
    assert.equal(loaded.messages.length, sampleMessages.length);
    assert.deepEqual(
      loaded.messages.map((m) => m.role),
      sampleMessages.map((m) => m.role),
    );
    assert.deepEqual(loaded.messages, sampleMessages);
    assert.deepEqual(completed.messages, sampleMessages);
  });
});

test("completeSession without messages omits the transcript (no `messages` key)", async () => {
  await withSessionHome(async () => {
    const created = await createSession(baseOptions);
    const completed = await completeSession(created, {
      summary: "x",
      changedFiles: [],
      nextSteps: [],
    });
    assert.equal("messages" in completed, false);
    const loaded = await loadSessionForResume(created.id);
    assert.equal(loaded.messages, undefined);
  });
});

test("loadSessionForResume throws a clean error for an unknown id", async () => {
  await withSessionHome(async () => {
    await assert.rejects(() => loadSessionForResume("does-not-exist"), /No session found/);
  });
});
