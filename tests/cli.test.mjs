import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_STEPS, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../dist/solar/constants.js";
import { parseCliArgs } from "../dist/cli.js";

test("parseCliArgs returns interactive defaults without arguments", () => {
  const command = parseCliArgs([]);

  assert.equal(command.mode, "interactive");
  assert.equal(command.cwd, process.cwd());
  assert.equal(command.maxSteps, DEFAULT_MAX_STEPS);
  assert.equal(command.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.equal(command.model, DEFAULT_MODEL);
  assert.equal(command.approvalPolicy, "on-failure");
  assert.equal(command.sandbox, "workspace-write");
  assert.equal(command.quiet, false);
});

test("parseCliArgs parses run flags", () => {
  const command = parseCliArgs([
    "run",
    "fix",
    "the",
    "bug",
    "--cwd",
    ".",
    "--max-steps",
    "4",
    "--reasoning",
    "high",
    "--model",
    "solar-test",
    "--approval-policy",
    "on-request",
    "--sandbox",
    "read-only",
    "--quiet",
  ]);

  assert.equal(command.mode, "run");
  assert.equal(command.goal, "fix the bug");
  assert.equal(command.cwd, process.cwd());
  assert.equal(command.maxSteps, 4);
  assert.equal(command.reasoningEffort, "high");
  assert.equal(command.model, "solar-test");
  assert.equal(command.approvalPolicy, "on-request");
  assert.equal(command.sandbox, "read-only");
  assert.equal(command.quiet, true);
});

test("parseCliArgs rejects invalid max steps", () => {
  assert.throws(() => parseCliArgs(["run", "goal", "--max-steps", "0"]), /positive number/);
});

test("parseCliArgs rejects unknown commands", () => {
  assert.throws(() => parseCliArgs(["unknown"]), /Unknown command/);
});

test("parseCliArgs accepts config commands", () => {
  assert.deepEqual(parseCliArgs(["config", "path"]), {
    mode: "config",
    action: "path",
  });
  assert.deepEqual(parseCliArgs(["config", "get", "model"]), {
    mode: "config",
    action: "get",
    key: "model",
  });
  assert.deepEqual(parseCliArgs(["config", "set", "model", "solar-test"]), {
    mode: "config",
    action: "set",
    key: "model",
    value: "solar-test",
  });
});

test("parseCliArgs can use config defaults", () => {
  const command = parseCliArgs([], {
    maxSteps: 3,
    reasoningEffort: "high",
    model: "solar-configured",
    approvalPolicy: "never",
    sandbox: "read-only",
    quiet: true,
  });

  assert.equal(command.mode, "interactive");
  assert.equal(command.maxSteps, 3);
  assert.equal(command.reasoningEffort, "high");
  assert.equal(command.model, "solar-configured");
  assert.equal(command.approvalPolicy, "never");
  assert.equal(command.sandbox, "read-only");
  assert.equal(command.quiet, true);
});

test("parseCliArgs accepts sessions commands", () => {
  assert.deepEqual(parseCliArgs(["sessions", "list"]), {
    mode: "sessions",
    action: "list",
  });
  assert.deepEqual(parseCliArgs(["sessions", "show", "abc"]), {
    mode: "sessions",
    action: "show",
    id: "abc",
  });
});
