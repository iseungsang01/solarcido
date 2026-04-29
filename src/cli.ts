import path from "node:path";

import type { ApprovalPolicy, SandboxMode } from "./config/schema.js";
import { DEFAULT_MAX_STEPS, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "./solar/constants.js";

export type CliDefaults = {
  maxSteps: number;
  reasoningEffort: ReasoningEffort;
  model: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  quiet: boolean;
};

export type CliCommand =
  | {
      mode: "run";
      goal: string;
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
    }
  | {
      mode: "interactive";
      cwd: string;
      maxSteps: number;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
    }
  | {
      mode: "config";
      action: "get" | "set" | "path";
      key?: string;
      value?: string;
    }
  | {
      mode: "sessions";
      action: "list" | "show";
      id?: string;
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
  solarcido run "your goal" [--cwd .] [--max-steps 10] [--reasoning low|medium|high] [--model name] [--approval-policy on-failure] [--sandbox workspace-write] [--quiet]
  solarcido config get [key]
  solarcido config set <key> <value>
  solarcido config path
  solarcido sessions list
  solarcido sessions show <id>

Options:
  --cwd <path>           working directory
  --max-steps <number>   assistant step limit
  --reasoning <level>    low | medium | high
  --model <name>         model to use for the coding assistant
  --approval-policy <p>  never | on-failure | on-request
  --sandbox <mode>       read-only | workspace-write
  --quiet                suppress assistant chat messages

Interactive shell:
  /                      show slash commands
  /help                  show slash commands
  /model                 show current model
  /model <name>          set model for this session
  /reasoning <level>     set reasoning level
  /max-steps <number>    set step limit
  /approval <policy>     set approval policy
  /sandbox <mode>        set sandbox mode
  /quiet                 suppress assistant chat messages
  /verbose               show assistant chat messages
  `);
}

const BUILT_IN_DEFAULTS: CliDefaults = {
  maxSteps: DEFAULT_MAX_STEPS,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  model: DEFAULT_MODEL,
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
  quiet: false,
};

export function parseCliArgs(argv: string[], defaults: CliDefaults = BUILT_IN_DEFAULTS): CliCommand {
  const [mode, ...rest] = argv;

  if (!mode) {
    return {
      mode: "interactive",
      cwd: process.cwd(),
      maxSteps: defaults.maxSteps,
      reasoningEffort: defaults.reasoningEffort,
      model: defaults.model,
      approvalPolicy: defaults.approvalPolicy,
      sandbox: defaults.sandbox,
      quiet: defaults.quiet,
    };
  }

  if (mode === "--help" || mode === "-h") {
    return { mode: "help" };
  }

  if (mode === "config") {
    const [action, key, ...valueParts] = rest;

    if (action === "path") {
      return { mode: "config", action };
    }

    if (action === "get") {
      return { mode: "config", action, key };
    }

    if (action === "set") {
      const value = valueParts.join(" ").trim();
      if (!key || !value) {
        throw new Error("Usage: solarcido config set <key> <value>");
      }
      return { mode: "config", action, key, value };
    }

    throw new Error("Usage: solarcido config get [key] | config set <key> <value> | config path");
  }

  if (mode === "sessions") {
    const [action, id] = rest;

    if (action === "list") {
      return { mode: "sessions", action };
    }

    if (action === "show") {
      if (!id) {
        throw new Error("Usage: solarcido sessions show <id>");
      }
      return { mode: "sessions", action, id };
    }

    throw new Error("Usage: solarcido sessions list | sessions show <id>");
  }

  if (mode !== "run") {
    throw new Error(`Unknown command: ${mode}`);
  }

  const positional: string[] = [];
  let cwd = process.cwd();
  let maxSteps = defaults.maxSteps;
  let reasoningEffort: ReasoningEffort = defaults.reasoningEffort;
  let model = defaults.model;
  let approvalPolicy = defaults.approvalPolicy;
  let sandbox = defaults.sandbox;
  let quiet = defaults.quiet;

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

    if (token === "--approval-policy") {
      const value = rest[index + 1];
      if (value !== "never" && value !== "on-failure" && value !== "on-request") {
        throw new Error("--approval-policy must be never, on-failure, or on-request.");
      }
      approvalPolicy = value;
      index += 1;
      continue;
    }

    if (token === "--sandbox") {
      const value = rest[index + 1];
      if (value !== "read-only" && value !== "workspace-write") {
        throw new Error("--sandbox must be read-only or workspace-write.");
      }
      sandbox = value;
      index += 1;
      continue;
    }

    if (token === "--quiet") {
      quiet = true;
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
    approvalPolicy,
    sandbox,
    quiet,
  };
}
