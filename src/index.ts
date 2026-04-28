#!/usr/bin/env node

import "dotenv/config";

import { parseCliArgs, printHelp } from "./cli.js";
import { startInteractiveShell } from "./interactive.js";
import { printPlanOnly, runWorkflow } from "./workflow/run-agent-loop.js";

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.mode === "help") {
    printHelp();
    return;
  }

  if (command.mode === "interactive") {
    await startInteractiveShell(command);
    return;
  }

  if (command.mode === "plan") {
    await printPlanOnly(command);
    return;
  }

  await runWorkflow(command);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[error] ${message}`);
  process.exitCode = 1;
});
