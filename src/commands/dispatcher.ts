import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import type { ReasoningEffort } from "../api/client.js";

import { formatSlashCommandHelp, type ResolvedSlashCommand } from "./registry.js";
import { formatVersionInfo, getVersionInfo, getWorkingDiff } from "./introspection.js";
import { formatInitReport, initializeRepo } from "../cli/init.js";

export type SlashCommandSession = {
  cwd: string;
  reasoningEffort: ReasoningEffort;
  model: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  quiet?: boolean;
};

export type SlashCommandOutput = {
  writeLine(message: string): void;
  clear(): void;
};

export type SlashCommandDispatcherOptions = {
  output?: SlashCommandOutput;
  promptForReasoningLevel?: (current: ReasoningEffort) => Promise<ReasoningEffort | undefined>;
  formatLabel?: (label: string) => string;
  formatDim?: (message: string) => string;
};

export type SlashCommandDispatchResult = "handled" | "exit";

export async function dispatchSlashCommand(
  session: SlashCommandSession,
  command: ResolvedSlashCommand,
  options: SlashCommandDispatcherOptions = {},
): Promise<SlashCommandDispatchResult> {
  const output = options.output ?? consoleOutput;
  const label = options.formatLabel ?? ((value) => value);
  const dim = options.formatDim ?? ((value) => value);

  switch (command.name) {
    case "model":
      if (command.args.length === 1) {
        session.model = command.args[0];
      }
      output.writeLine(`  ${label("model")}  ${session.model}`);
      return "handled";
    case "reasoning":
      if (command.args.length === 1) {
        const value = command.args[0];
        if (value === "low" || value === "medium" || value === "high") {
          session.reasoningEffort = value;
          output.writeLine(`  ${label("reasoning")}  ${session.reasoningEffort}`);
          return "handled";
        }

        output.writeLine(`  ${label("reasoning")}  ${session.reasoningEffort}`);
        output.writeLine(`  ${dim("use /reasoning high | medium | low")}`);
        return "handled";
      }

      if (options.promptForReasoningLevel) {
        const selected = await options.promptForReasoningLevel(session.reasoningEffort);
        if (selected) session.reasoningEffort = selected;
      }
      output.writeLine(`  ${label("reasoning")}  ${session.reasoningEffort}`);
      return "handled";
    case "approval":
      if (command.args.length === 1) {
        const value = command.args[0];
        if (value === "never" || value === "on-failure" || value === "on-request") {
          session.approvalPolicy = value;
        }
      }
      output.writeLine(`  ${label("approval")}  ${session.approvalPolicy ?? "on-failure"}`);
      return "handled";
    case "sandbox":
      if (command.args.length === 1) {
        const value = command.args[0];
        if (value === "read-only" || value === "workspace-write") {
          session.sandbox = value;
        }
      }
      output.writeLine(`  ${label("sandbox")}  ${session.sandbox ?? "workspace-write"}`);
      return "handled";
    case "cwd":
      output.writeLine(`  ${label("cwd")}  ${session.cwd}`);
      return "handled";
    case "status":
      writeStatus(session, output, label);
      return "handled";
    case "clear":
      output.clear();
      return "handled";
    case "quiet":
      session.quiet = true;
      output.writeLine(`  ${label("quiet")}  on`);
      return "handled";
    case "verbose":
      session.quiet = false;
      output.writeLine(`  ${label("quiet")}  off`);
      return "handled";
    case "help":
      output.writeLine(formatSlashCommandHelp());
      return "handled";
    case "config":
      output.writeLine("  solarcido config get [key] | config set <key> <value> | config path");
      return "handled";
    case "sessions":
      output.writeLine("  solarcido sessions list | sessions show <id>");
      return "handled";
    case "version":
      output.writeLine(formatVersionInfo(getVersionInfo()));
      return "handled";
    case "diff":
      output.writeLine(await getWorkingDiff(session.cwd));
      return "handled";
    case "init": {
      const report = await initializeRepo(session.cwd);
      output.writeLine(formatInitReport(report));
      return "handled";
    }
    case "resume":
      output.writeLine('  Resume a saved session with: solarcido run "<goal>" --resume <id>');
      output.writeLine("  List session ids with: solarcido sessions list");
      return "handled";
    case "exit":
      return "exit";
    default:
      output.writeLine(`  Unknown command: /${command.name}`);
      return "handled";
  }
}

function writeStatus(
  session: SlashCommandSession,
  output: SlashCommandOutput,
  label: (label: string) => string,
): void {
  output.writeLine(`  ${label("model")}      ${session.model}`);
  output.writeLine(`  ${label("cwd")}        ${session.cwd}`);
  output.writeLine(`  ${label("reasoning")}  ${session.reasoningEffort}`);
  output.writeLine(`  ${label("approval")}   ${session.approvalPolicy ?? "on-failure"}`);
  output.writeLine(`  ${label("sandbox")}    ${session.sandbox ?? "workspace-write"}`);
  output.writeLine(`  ${label("quiet")}      ${session.quiet ? "on" : "off"}`);
}

const consoleOutput: SlashCommandOutput = {
  writeLine(message: string): void {
    console.log(message);
  },
  clear(): void {
    console.clear();
  },
};
