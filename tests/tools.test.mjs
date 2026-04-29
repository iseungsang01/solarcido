import assert from "node:assert/strict";
import { mkdtemp, readFile as readFsFile, rm, writeFile as writeFsFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { editFile, readFile, searchFiles } from "../dist/tools/filesystem.js";
import { formatCommandOutput, runCommand } from "../dist/tools/process.js";

async function withTempWorkspace(run) {
  const parent = await mkdtemp(path.join(tmpdir(), "solarcido-test-"));
  const root = path.join(parent, "workspace");
  await writeFsFile(path.join(parent, "outside.txt"), "outside", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root));

  try {
    return await run({ parent, root });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("readFile rejects paths outside the workspace", async () => {
  await withTempWorkspace(async ({ root }) => {
    await assert.rejects(() => readFile(root, "../outside.txt"), /escapes the working directory/);
  });
});

test("readFile supports line windows", async () => {
  await withTempWorkspace(async ({ root }) => {
    await writeFsFile(path.join(root, "sample.txt"), "one\ntwo\nthree\nfour", "utf8");

    const result = await readFile(root, "sample.txt", 2, 2);

    assert.deepEqual(result, {
      ok: true,
      output: "2 | two\n3 | three",
    });
  });
});

test("searchFiles returns path line matches", async () => {
  await withTempWorkspace(async ({ root }) => {
    await writeFsFile(path.join(root, "sample.txt"), "alpha\nbeta\nalphabet", "utf8");

    const result = await searchFiles(root, "alpha");

    assert.deepEqual(result, {
      ok: true,
      output: "sample.txt:1: alpha\nsample.txt:3: alphabet",
    });
  });
});

test("editFile rejects ambiguous replacements unless replaceAll is true", async () => {
  await withTempWorkspace(async ({ root }) => {
    const target = path.join(root, "sample.txt");
    await writeFsFile(target, "same same", "utf8");

    await assert.rejects(() => editFile(root, "sample.txt", "same", "other"), /appears 2 times/);

    const result = await editFile(root, "sample.txt", "same", "other", true);
    const content = await readFsFile(target, "utf8");

    assert.deepEqual(result, {
      ok: true,
      output: "Edited sample.txt (2 replacements)",
    });
    assert.equal(content, "other other");
  });
});

test("formatCommandOutput includes exit code and stdout", () => {
  assert.equal(formatCommandOutput("ok\n", "", 0), "exit_code: 0\n\nstdout:\nok");
});

test("formatCommandOutput includes exit code and stderr", () => {
  assert.equal(formatCommandOutput("", "bad", 7), "exit_code: 7\n\nstderr:\nbad");
});

test("runCommand returns structured output from command execution", async () => {
  await withTempWorkspace(async ({ root }) => {
    const result = await runCommand(root, "node -e \"console.log('ok')\"");

    assert.match(result.output, /exit_code:/);
    if (result.ok) {
      assert.match(result.output, /stdout:\nok/);
    } else {
      assert.match(result.output, /stderr:/);
    }
  });
});
