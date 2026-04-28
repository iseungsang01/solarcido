import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { printHelp } from "./cli.js";
import type { ReasoningEffort } from "./solar/constants.js";
import { printPlanOnly, runWorkflow } from "./workflow/run-agent-loop.js";

export type InteractiveOptions = {
  cwd: string;
  maxSteps: number;
  reasoningEffort: ReasoningEffort;
};

function printShellHeader(options: InteractiveOptions): void {
  console.log(`
solarcido

Natural language coding shell for Upstage solar-pro3-260323.
Just type what you want.

Examples:
  > 이 저장소 구조 분석해줘
  > README 정리해줘
  > sample.txt 파일 만들고 내용 써줘

Commands:
  /help                 show help
  /plan <goal>          create plan only
  /run <goal>           run workflow explicitly
  /cwd                  show working directory
  /reasoning            show reasoning level
  /max-steps            show max steps
  /exit                 quit

Current settings:
  cwd: ${options.cwd}
  reasoning: ${options.reasoningEffort}
  max steps: ${options.maxSteps}
`);
}

export async function startInteractiveShell(options: InteractiveOptions): Promise<void> {
  printShellHeader(options);

  const rl = createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const raw = await rl.question("solarcido> ");
      const command = raw.trim();

      if (!command) {
        continue;
      }

      if (command === "/exit" || command === "exit" || command === "quit") {
        console.log("\nBye.");
        break;
      }

      if (command === "/help") {
        printHelp();
        continue;
      }

      if (command === "/cwd") {
        console.log(`cwd: ${options.cwd}`);
        continue;
      }

      if (command === "/reasoning") {
        console.log(`reasoning: ${options.reasoningEffort}`);
        continue;
      }

      if (command === "/max-steps") {
        console.log(`max steps: ${options.maxSteps}`);
        continue;
      }

      if (command.startsWith("/plan ")) {
        const goal = command.slice(6).trim();

        if (!goal) {
          console.log("Usage: /plan <goal>");
          continue;
        }

        await printPlanOnly({
          goal,
          cwd: options.cwd,
          maxSteps: options.maxSteps,
          reasoningEffort: options.reasoningEffort,
        });
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
          cwd: options.cwd,
          maxSteps: options.maxSteps,
          reasoningEffort: options.reasoningEffort,
        });
        continue;
      }

      await runWorkflow({
        goal: command,
        cwd: options.cwd,
        maxSteps: options.maxSteps,
        reasoningEffort: options.reasoningEffort,
      });
    }
  } finally {
    rl.close();
  }
}
