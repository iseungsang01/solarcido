import { getConfigPath, getConfigValue, loadConfig, parseConfigKey, parseConfigValue, saveConfig } from "./config/load-config.js";
import { printHelp, parseCliArgs, type CliCommand } from "./cli.js";
import { listSessions, readSession } from "./sessions/session-store.js";
import { startInteractiveShell } from "./interactive.js";
import { runWorkflow } from "./workflow/run-agent-loop.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const command = parseCliArgs(process.argv.slice(2), config);

  switch (command.mode) {
    case "help":
      printHelp();
      return;
    case "interactive":
      await startInteractiveShell(command);
      return;
    case "run":
      await runWorkflow(command);
      return;
    case "config":
      await handleConfigCommand(command);
      return;
    case "sessions":
      await handleSessionsCommand(command);
      return;
  }
}

async function handleConfigCommand(command: Extract<CliCommand, { mode: "config" }>): Promise<void> {
  const config = await loadConfig();

  switch (command.action) {
    case "path":
      console.log(getConfigPath());
      return;
    case "get":
      if (!command.key) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      console.log(formatValue(getConfigValue(config, parseConfigKey(command.key))));
      return;
    case "set": {
      const key = parseConfigKey(command.key ?? "");
      const value = parseConfigValue(key, command.value ?? "");
      await saveConfig({
        ...config,
        [key]: value,
      });
      console.log(`${key}=${formatValue(value)}`);
      return;
    }
  }
}

async function handleSessionsCommand(command: Extract<CliCommand, { mode: "sessions" }>): Promise<void> {
  switch (command.action) {
    case "list": {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }

      for (const session of sessions) {
        console.log(`${session.id}  ${session.status}  ${session.goal}`);
      }
      return;
    }
    case "show": {
      const session = await readSession(command.id ?? "");
      console.log(JSON.stringify(session, null, 2));
      return;
    }
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`solarcido: ${message}`);
  process.exitCode = 1;
});
