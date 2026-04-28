import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { printHelp } from "./cli.js";
import { DEFAULT_MODEL, type ReasoningEffort } from "./solar/constants.js";
import { runWorkflow } from "./workflow/run-agent-loop.js";

export type InteractiveOptions = {
  cwd: string;
  maxSteps: number;
  reasoningEffort: ReasoningEffort;
  model: string;
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  yellow: "\u001b[38;5;220m",
  amber: "\u001b[38;5;214m",
  blue: "\u001b[38;5;111m",
  slate: "\u001b[38;5;244m",
  panel: "\u001b[48;5;236m",
} as const;

const LOGO_LINES = [
  " ███████╗ ██████╗ ██╗      █████╗ ██████╗  ██████╗██╗██████╗  ██████╗ ",
  " ██╔════╝██╔═══██╗██║     ██╔══██╗██╔══██╗██╔════╝██║██╔══██╗██╔═══██╗",
  " ███████╗██║   ██║██║     ███████║██████╔╝██║     ██║██║  ██║██║   ██║",
  " ╚════██║██║   ██║██║     ██╔══██║██╔══██╗██║     ██║██║  ██║██║   ██║",
  " ███████║╚██████╔╝███████╗██║  ██║██║  ██║╚██████╗██║██████╔╝╚██████╔╝",
  " ╚══════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝╚═════╝  ╚═════╝ ",
];

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function centerLine(value: string, width = output.columns ?? 100): string {
  const visibleWidth = stripAnsi(value).length;
  const padding = Math.max(0, Math.floor((width - visibleWidth) / 2));
  return `${" ".repeat(padding)}${value}`;
}

function fitText(value: string, width: number): string {
  const clean = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clean.padEnd(width, " ");
}

function printPanel(title: string, lines: string[]): void {
  const terminalWidth = output.columns ?? 100;
  const panelWidth = Math.min(Math.max(terminalWidth - 10, 54), 96);
  const innerWidth = panelWidth - 4;
  const top = centerLine(`${ANSI.blue}╭─ ${title} ${"─".repeat(Math.max(0, innerWidth - title.length - 2))}╮${ANSI.reset}`, terminalWidth);
  const bottom = centerLine(`${ANSI.blue}╰${"─".repeat(panelWidth - 2)}╯${ANSI.reset}`, terminalWidth);

  console.log(top);
  for (const line of lines) {
    const row = `${ANSI.blue}│${ANSI.reset} ${ANSI.panel}${fitText(line, innerWidth)}${ANSI.reset} ${ANSI.blue}│${ANSI.reset}`;
    console.log(centerLine(row, terminalWidth));
  }
  console.log(bottom);
}

function printLogo(): void {
  console.log("");
  for (const line of LOGO_LINES) {
    console.log(centerLine(`${ANSI.yellow}${ANSI.bold}${line}${ANSI.reset}`));
  }
  console.log("");
}

function printShellHeader(options: InteractiveOptions): void {
  printLogo();
  printPanel("SOLARCIDO CODE", [
    "Ask for code changes, repo analysis, or execution.",
    "Start a line with / to open command actions.",
    "",
    `model      ${options.model}`,
    `cwd        ${options.cwd}`,
    `reasoning  ${options.reasoningEffort}`,
    `max steps  ${options.maxSteps}`,
  ]);
  console.log("");
}

function printSlashCommands(options: InteractiveOptions): void {
  printPanel("SLASH COMMANDS", [
    "/help                 show CLI help",
    "/run <goal>           run the workflow explicitly",
    "/model                show current model",
    "/model <name>         change model for this session",
    "/cwd                  show working directory",
    "/reasoning            show reasoning level",
    "/max-steps            show max steps",
    "/exit                 quit",
    "",
    `active model         ${options.model}`,
  ]);
}

export async function startInteractiveShell(options: InteractiveOptions): Promise<void> {
  const session: InteractiveOptions = {
    cwd: options.cwd,
    maxSteps: options.maxSteps,
    reasoningEffort: options.reasoningEffort,
    model: options.model || DEFAULT_MODEL,
  };

  printShellHeader(session);

  const rl = createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const raw = await rl.question(`${ANSI.amber}${ANSI.bold}code${ANSI.reset} ${ANSI.slate}❯${ANSI.reset} `);
      const command = raw.trim();

      if (!command) {
        continue;
      }

      if (command === "/exit" || command === "exit" || command === "quit") {
        console.log("\nBye.");
        break;
      }

      if (command === "/") {
        printSlashCommands(session);
        continue;
      }

      if (command === "/help") {
        printHelp();
        continue;
      }

      if (command === "/cwd") {
        console.log(`cwd: ${session.cwd}`);
        continue;
      }

      if (command === "/reasoning") {
        console.log(`reasoning: ${session.reasoningEffort}`);
        continue;
      }

      if (command === "/max-steps") {
        console.log(`max steps: ${session.maxSteps}`);
        continue;
      }

      if (command === "/model") {
        console.log(`model: ${session.model}`);
        continue;
      }

      if (command.startsWith("/model ")) {
        const nextModel = command.slice(7).trim();

        if (!nextModel) {
          console.log("Usage: /model <name>");
          continue;
        }

        session.model = nextModel;
        console.log(`model updated: ${session.model}`);
        continue;
      }

      if (command.startsWith("/run ")) {
        const goal = command.slice(5).trim();

        if (!goal) {
          console.log("Usage: /run <goal>");
          continue;
        }

        await runWorkflow({
          goal,
          cwd: session.cwd,
          maxSteps: session.maxSteps,
          reasoningEffort: session.reasoningEffort,
          model: session.model,
        });
        continue;
      }

      if (command.startsWith("/")) {
        printSlashCommands(session);
        continue;
      }

      await runWorkflow({
        goal: command,
        cwd: session.cwd,
        maxSteps: session.maxSteps,
        reasoningEffort: session.reasoningEffort,
        model: session.model,
      });
    }
  } finally {
    rl.close();
  }
}
