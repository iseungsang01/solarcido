import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../dist/api/client.js";
import { parseCliArgs } from "../dist/cli.js";
import { parseCliArgs as parseThinCliArgs } from "../dist/cli/parse-args.js";
import { dispatchSlashCommand } from "../dist/commands/dispatcher.js";
import {
  formatCliInteractiveHelp,
  formatSlashCommandHelp,
  listSlashCommands,
  parseSlashCommand,
} from "../dist/commands/registry.js";

test("parseCliArgs returns interactive defaults without arguments", () => {
  const command = parseCliArgs([]);

  assert.equal(command.mode, "interactive");
  assert.equal(command.cwd, process.cwd());
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
  assert.equal(command.reasoningEffort, "high");
  assert.equal(command.model, "solar-test");
  assert.equal(command.approvalPolicy, "on-request");
  assert.equal(command.sandbox, "read-only");
  assert.equal(command.quiet, true);
});

test("parseCliArgs accepts deprecated max steps as a no-op", () => {
  const command = parseCliArgs(["run", "goal", "--max-steps", "4"]);
  assert.equal(command.mode, "run");
  assert.equal(command.goal, "goal");
});

test("parseCliArgs rejects invalid deprecated max steps", () => {
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
    reasoningEffort: "high",
    model: "solar-configured",
    approvalPolicy: "never",
    sandbox: "read-only",
    quiet: true,
  });

  assert.equal(command.mode, "interactive");
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
test("parseCliArgs is available from the thin CLI parser module", () => {
  assert.deepEqual(parseThinCliArgs(["config", "path"]), {
    mode: "config",
    action: "path",
  });
});

test("slash command registry exposes required commands and aliases", () => {
  const names = listSlashCommands().map((command) => command.name);

  assert.deepEqual(names, [
    "help",
    "status",
    "model",
    "reasoning",
    "approval",
    "sandbox",
    "cwd",
    "clear",
    "quiet",
    "verbose",
    "exit",
    "config",
    "sessions",
    "version",
    "diff",
  ]);
  assert.equal(parseSlashCommand("/quit")?.name, "exit");
  assert.equal(parseSlashCommand("/")?.name, "help");
});

test("slash command help is generated from command registry specs", () => {
  const help = formatSlashCommandHelp();
  const cliHelp = formatCliInteractiveHelp();

  assert.match(help, /\/model \[name\]\s+show or set model/);
  assert.match(help, /\/exit\s+quit \(\/quit\)/);
  assert.match(help, /\/sessions list\|show\s+show sessions command usage/);
  assert.match(cliHelp, /\/help\s+show available commands/);
  assert.match(cliHelp, /\/sessions list\|show\s+show sessions command usage/);
});

test("slash command dispatcher updates session state", async () => {
  const session = {
    cwd: process.cwd(),
    reasoningEffort: "high",
    model: "solar-test",
    approvalPolicy: "on-failure",
    sandbox: "workspace-write",
    quiet: false,
  };
  const lines = [];
  const output = {
    writeLine(message) {
      lines.push(message);
    },
    clear() {},
  };

  await dispatchSlashCommand(session, parseSlashCommand("/reasoning low"), { output });
  await dispatchSlashCommand(session, parseSlashCommand("/approval never"), { output });
  await dispatchSlashCommand(session, parseSlashCommand("/quiet"), { output });

  assert.equal(session.reasoningEffort, "low");
  assert.equal(session.approvalPolicy, "never");
  assert.equal(session.quiet, true);
  assert.match(lines.join("\n"), /reasoning\s+low/);
});

