import path from "node:path";

import { DEFAULT_MAX_STEPS, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "./solar/constants.js";

export type CliCommand =
  | {
      mode: "run" | "plan";
      goal: string;
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
      model: string;
    }
  | {
      mode: "interactive";
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
      model: string;
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
  solarcido run "your goal" [--cwd .] [--max-steps 10] [--reasoning low|medium|high] [--model name]
  solarcido plan "your goal" [--reasoning low|medium|high] [--model name]

Options:
  --cwd <path>           working directory
  --max-steps <number>   executor step limit
  --reasoning <level>    low | medium | high
  --model <name>         model to use for planner/executor/reviewer

Interactive shell:
  /                      show slash commands
  /model                 show current model
  /model <name>          set model for this session
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
      model: DEFAULT_MODEL,
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
  let model = DEFAULT_MODEL;

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

    if (token === "--model") {
      const nextModel = rest[index + 1]?.trim();

      if (!nextModel) {
        throw new Error("--model requires a value.");
      }

      model = nextModel;
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
    model,
  };
}
