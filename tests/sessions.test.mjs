import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import {
  completeSession,
  createSession,
  failSession,
  listSessions,
  readSession,
} from "../dist/sessions/session-store.js";

async function withSessionHome(run) {
  const previousHome = process.env.SOLARCIDO_HOME;
  const home = await mkdtemp(path.join(tmpdir(), "solarcido-session-test-"));
  process.env.SOLARCIDO_HOME = home;

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.SOLARCIDO_HOME;
    } else {
      process.env.SOLARCIDO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

const baseSessionOptions = {
  goal: "test goal",
  cwd: process.cwd(),
  model: "solar-test",
  reasoningEffort: "medium",
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
};

test("createSession writes a running session record", async () => {
  await withSessionHome(async () => {
    const created = await createSession(baseSessionOptions);
    const read = await readSession(created.id);

    assert.deepEqual(read, created);
    assert.equal(read.status, "running");
    assert.equal(read.goal, "test goal");
  });
});

test("completeSession stores finish metadata", async () => {
  await withSessionHome(async () => {
    const created = await createSession(baseSessionOptions);
    const completed = await completeSession(created, {
      summary: "done",
      changedFiles: ["a.ts"],
      nextSteps: ["ship"],
    });

    assert.deepEqual(await readSession(created.id), completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.summary, "done");
    assert.deepEqual(completed.changedFiles, ["a.ts"]);
    assert.deepEqual(completed.nextSteps, ["ship"]);
  });
});

test("failSession stores failure metadata", async () => {
  await withSessionHome(async () => {
    const created = await createSession(baseSessionOptions);
    const failed = await failSession(created, "bad");

    assert.deepEqual(await readSession(created.id), failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "bad");
  });
});

test("listSessions returns newest sessions first", async () => {
  await withSessionHome(async () => {
    const first = await createSession({ ...baseSessionOptions, goal: "first" });
    await setTimeout(5);
    const second = await createSession({ ...baseSessionOptions, goal: "second" });

    const sessions = await listSessions();

    assert.deepEqual(
      sessions.map((session) => session.id),
      [second.id, first.id],
    );
  });
});
