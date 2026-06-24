import { getConfigPath, getConfigValue, loadConfig, parseConfigKey, parseConfigValue, saveConfig } from "../runtime/config.js";
import { listSessions, readSession } from "../runtime/session.js";
import { runWorkflow } from "../workflow/run-agent-loop.js";
import { formatCliInteractiveHelp } from "../commands/registry.js";

import { parseCliArgs, type CliCommand } from "./parse-args.js";
import { startInteractiveShell } from "./repl.js";
import { formatInitReport, initializeRepo } from "./init.js";
import { formatTeamReport, loadTasksFile, runTeam } from "../workflow/team.js";
import { formatOrchestrationResult, orchestrateGoal } from "../workflow/orchestrator.js";
import { createApiClientForModel } from "../api/client.js";
import { loadCronJobs, runCronDaemon } from "../workflow/cron-daemon.js";
import { runLspDiagnosticsCommand } from "../workflow/lsp-command.js";
import { runMcpServeCommand } from "../workflow/mcp-serve-command.js";

export function printHelp(): void {
  console.log(`
solarcido

TypeScript CLI for the current repository.

Usage:
  solarcido
  solarcido run "your goal" [--cwd .] [--reasoning low|medium|high] [--model name] [--approval-policy on-failure|on-request|never] [--sandbox read-only|workspace-write] [--quiet] [--resume <id>]
  solarcido init [--cwd .]
  solarcido team <tasks.json> [--concurrency N] [--cwd .] [--model name] [--sandbox ...]
  solarcido orchestrate "your goal" [--cwd .] [--model name] [--sandbox ...]
  solarcido cron <cron.json> [--cwd .] [--model name] [--sandbox ...]
  solarcido lsp <file> [--server "<command>"] [--settle-ms N]
  solarcido mcp-serve [--cwd .] [--approval-policy ...] [--sandbox ...]
  solarcido config get [key]
  solarcido config set <key> <value>
  solarcido config path
  solarcido sessions list
  solarcido sessions show <id>

Options:
  --cwd <path>           working directory
  --reasoning <level>    low | medium | high
  --model <name>         model to use for the coding assistant
  --approval-policy <p>  never | on-failure | on-request
  --sandbox <mode>       read-only | workspace-write
  --quiet                suppress assistant chat messages
  --resume <id>          continue a saved session (see: sessions list)
  --stream / --no-stream stream model output token-by-token (config: stream)

Interactive shell:
${formatCliInteractiveHelp()}
  `);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig();
  const command = parseCliArgs(argv, config);

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
    case "init": {
      const report = await initializeRepo(command.cwd);
      console.log(formatInitReport(report));
      return;
    }
    case "team": {
      const tasks = loadTasksFile(command.file);
      const report = await runTeam({
        tasks,
        cwd: command.cwd,
        reasoningEffort: command.reasoningEffort,
        model: command.model,
        approvalPolicy: command.approvalPolicy,
        sandbox: command.sandbox,
        concurrency: command.concurrency,
        quiet: command.quiet,
      });
      console.log(formatTeamReport(report));
      return;
    }
    case "orchestrate": {
      const client = createApiClientForModel(command.model);
      const result = await orchestrateGoal(
        client,
        command.goal,
        command.cwd,
        command.reasoningEffort,
        command.model,
        command.approvalPolicy,
        command.sandbox,
      );
      console.log(formatOrchestrationResult(result));
      return;
    }
    case "cron": {
      const jobs = loadCronJobs(command.file);
      await runCronDaemon({
        jobs,
        cwd: command.cwd,
        reasoningEffort: command.reasoningEffort,
        model: command.model,
        approvalPolicy: command.approvalPolicy,
        sandbox: command.sandbox,
      });
      return;
    }
    case "lsp": {
      const output = await runLspDiagnosticsCommand({
        file: command.file,
        server: command.server,
        settleMs: command.settleMs,
      });
      console.log(output);
      return;
    }
    case "mcp-serve": {
      await runMcpServeCommand({
        cwd: command.cwd,
        approvalPolicy: command.approvalPolicy,
        sandbox: command.sandbox,
      });
      return;
    }
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
