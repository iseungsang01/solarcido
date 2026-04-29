#!/usr/bin/env node

import "dotenv/config";

import { parseCliArgs, printHelp } from "./cli.js";
import {
  getConfigPath,
  getConfigValue,
  loadConfig,
  parseConfigKey,
  parseConfigValue,
  saveConfig,
  setConfigValue,
} from "./config/load-config.js";
import { startInteractiveShell } from "./interactive.js";
import { listSessions, readSession } from "./sessions/session-store.js";
import { runWorkflow } from "./workflow/run-agent-loop.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (firstArg === "--help" || firstArg === "-h") {
    printHelp();
    return;
  }

  if (firstArg === "config" || firstArg === "sessions") {
    await handleUtilityCommand(parseCliArgs(argv));
    return;
  }

  const config = await loadConfig();
  const command = parseCliArgs(argv, {
    reasoningEffort: config.reasoningEffort,
    model: config.model,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    quiet: config.quiet,
  });

  if (command.mode === "help") {
    printHelp();
    return;
  }

  if (command.mode === "interactive") {
    await startInteractiveShell(command);
    return;
  }

  if (command.mode === "config") {
    await handleUtilityCommand(command);
    return;
  }

  if (command.mode === "sessions") {
    await handleUtilityCommand(command);
    return;
  }

  await runWorkflow(command);
}

async function handleUtilityCommand(command: ReturnType<typeof parseCliArgs>): Promise<void> {
  if (command.mode === "config") {
    await handleConfigCommand(command);
    return;
  }

  if (command.mode === "sessions") {
    await handleSessionsCommand(command);
    return;
  }

  throw new Error("Expected a utility command.");
}

async function handleConfigCommand(command: Extract<ReturnType<typeof parseCliArgs>, { mode: "config" }>): Promise<void> {

  if (command.action === "path") {
    console.log(getConfigPath());
    return;
  }

  const config = await loadConfig();

  if (command.action === "get") {
    const key = command.key ? parseConfigKey(command.key) : undefined;
    console.log(JSON.stringify(getConfigValue(config, key), null, 2));
    return;
  }

  const key = parseConfigKey(command.key ?? "");
  const value = parseConfigValue(key, command.value ?? "");
  await saveConfig(setConfigValue(config, key, value));
  console.log(`Updated ${key}`);
}

async function handleSessionsCommand(command: Extract<ReturnType<typeof parseCliArgs>, { mode: "sessions" }>): Promise<void> {
  if (command.action === "list") {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No sessions.");
      return;
    }

    for (const session of sessions) {
      const summary = session.summary ? ` - ${session.summary}` : "";
      console.log(`${session.id}  ${session.status}  ${session.createdAt}  ${session.goal}${summary}`);
    }
    return;
  }

  if (!command.id) {
    throw new Error("Usage: solarcido sessions show <id>");
  }

  console.log(JSON.stringify(await readSession(command.id), null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[error] ${message}`);
  process.exitCode = 1;
});
