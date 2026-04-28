import path from "node:path";

import { DEFAULT_MAX_STEPS, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "./solar/constants.js";

export type CliCommand =
  | {
      mode: "run" | "plan";
      goal: string;
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
    }
  | {
      mode: "interactive";
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
    }
  | { mode: "help" };

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return DEFAULT_REASONING_EFFORT;
}

export function printHelp(): void {
  console.log(`
solarcido

Usage:
  solarcido
  solarcido run "your goal" [--cwd .] [--max-steps 10] [--reasoning low|medium|high]
  solarcido plan "your goal" [--reasoning low|medium|high]

Examples:
  solarcido
  solarcido plan "Create a CLI design"
  solarcido run "Inspect this repo and summarize it" --cwd . --max-steps 8 --reasoning medium
  `);
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [mode, ...rest] = argv;

  if (!mode) {
    return {
      mode: "interactive",
      cwd: process.cwd(),
      maxSteps: DEFAULT_MAX_STEPS,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    };
  }

  if (mode === "--help" || mode === "-h") {
    return { mode: "help" };
  }

  if (mode !== "run" && mode !== "plan") {
    throw new Error(`Unknown command: ${mode}`);
  }

  const positional: string[] = [];
  let cwd = process.cwd();
  let maxSteps = DEFAULT_MAX_STEPS;
  let reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--cwd") {
      cwd = path.resolve(rest[index + 1] ?? process.cwd());
      index += 1;
      continue;
    }

    if (token === "--max-steps") {
      const raw = Number(rest[index + 1]);

      if (!Number.isFinite(raw) || raw < 1) {
        throw new Error("--max-steps must be a positive number.");
      }

      maxSteps = raw;
      index += 1;
      continue;
    }

    if (token === "--reasoning") {
      reasoningEffort = parseReasoningEffort(rest[index + 1]);
      index += 1;
      continue;
    }

    positional.push(token);
  }

  const goal = positional.join(" ").trim();

  if (!goal) {
    throw new Error("A goal string is required.");
  }

  return {
    mode,
    goal,
    cwd,
    maxSteps,
    reasoningEffort,
  };
}
