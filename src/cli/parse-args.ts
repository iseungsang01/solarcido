import path from "node:path";

import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../api/client.js";

export type CliDefaults = {
  reasoningEffort: ReasoningEffort;
  model: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  quiet: boolean;
  stream: boolean;
};

export type CliCommand =
  | {
      mode: "run";
      goal: string;
      cwd: string;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
      stream: boolean;
      resume?: string;
    }
  | {
      mode: "interactive";
      cwd: string;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
      stream: boolean;
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
  | {
      mode: "team";
      file: string;
      cwd: string;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
      concurrency: number;
    }
  | {
      mode: "orchestrate";
      goal: string;
      cwd: string;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      quiet: boolean;
    }
  | {
      mode: "cron";
      file: string;
      cwd: string;
      reasoningEffort: ReasoningEffort;
      model: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
    }
  | { mode: "init"; cwd: string }
  | { mode: "lsp"; file: string; server?: string; settleMs?: number }
  | {
      mode: "mcp-serve";
      cwd: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
    }
  | { mode: "help" };

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return DEFAULT_REASONING_EFFORT;
}

const BUILT_IN_DEFAULTS: CliDefaults = {
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  model: DEFAULT_MODEL,
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
  quiet: false,
  stream: false,
};

export function parseCliArgs(argv: string[], defaults: CliDefaults = BUILT_IN_DEFAULTS): CliCommand {
  const [mode, ...rest] = argv;

  if (!mode) {
    return {
      mode: "interactive",
      cwd: process.cwd(),
      reasoningEffort: defaults.reasoningEffort,
      model: defaults.model,
      approvalPolicy: defaults.approvalPolicy,
      sandbox: defaults.sandbox,
      quiet: defaults.quiet,
      stream: defaults.stream,
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

  if (mode === "init") {
    let cwd = process.cwd();
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--cwd") {
        cwd = path.resolve(rest[index + 1] ?? process.cwd());
        index += 1;
      }
    }
    return { mode: "init", cwd };
  }

  if (mode === "lsp") {
    const lspPositional: string[] = [];
    let server: string | undefined;
    let settleMs: number | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--server") {
        server = rest[index + 1];
        if (!server) throw new Error("--server requires a command string.");
        index += 1;
        continue;
      }
      if (token === "--settle-ms") {
        const raw = Number(rest[index + 1]);
        if (!Number.isFinite(raw) || raw < 0) throw new Error("--settle-ms must be a non-negative number.");
        settleMs = raw;
        index += 1;
        continue;
      }
      lspPositional.push(token);
    }
    const file = lspPositional[0];
    if (!file) {
      throw new Error('Usage: solarcido lsp <file> [--server "<command>"] [--settle-ms N]');
    }
    return { mode: "lsp", file: path.resolve(file), server, settleMs };
  }

  if (mode === "mcp-serve") {
    let cwd = process.cwd();
    let approvalPolicy = defaults.approvalPolicy;
    let sandbox = defaults.sandbox;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--cwd") {
        cwd = path.resolve(rest[index + 1] ?? process.cwd());
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
      throw new Error(`Unknown flag for mcp-serve: ${token}`);
    }
    return { mode: "mcp-serve", cwd, approvalPolicy, sandbox };
  }

  if (mode !== "run" && mode !== "team" && mode !== "orchestrate" && mode !== "cron") {
    throw new Error(`Unknown command: ${mode}`);
  }

  const positional: string[] = [];
  let cwd = process.cwd();
  let reasoningEffort: ReasoningEffort = defaults.reasoningEffort;
  let model = defaults.model;
  let approvalPolicy = defaults.approvalPolicy;
  let sandbox = defaults.sandbox;
  let quiet = defaults.quiet;
  let stream = defaults.stream;
  let resume: string | undefined;
  let concurrency = 1;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--stream") {
      stream = true;
      continue;
    }

    if (token === "--no-stream") {
      stream = false;
      continue;
    }

    if (token === "--resume") {
      const value = rest[index + 1]?.trim();
      if (!value) {
        throw new Error("--resume requires a session id.");
      }
      resume = value;
      index += 1;
      continue;
    }

    if (token === "--cwd") {
      cwd = path.resolve(rest[index + 1] ?? process.cwd());
      index += 1;
      continue;
    }

    if (token === "--concurrency") {
      const raw = Number(rest[index + 1]);
      if (!Number.isInteger(raw) || raw < 1) {
        throw new Error("--concurrency must be a positive integer.");
      }
      concurrency = raw;
      index += 1;
      continue;
    }

    if (token === "--max-steps") {
      const raw = Number(rest[index + 1]);

      if (!Number.isFinite(raw) || raw < 1) {
        throw new Error("--max-steps must be a positive number.");
      }

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

  if (mode === "team") {
    const file = positional[0];
    if (!file) {
      throw new Error("Usage: solarcido team <tasks.json> [--concurrency N] [run flags]");
    }
    return {
      mode: "team",
      file: path.resolve(file),
      cwd,
      reasoningEffort,
      model,
      approvalPolicy,
      sandbox,
      quiet,
      concurrency,
    };
  }

  if (mode === "cron") {
    const file = positional[0];
    if (!file) {
      throw new Error("Usage: solarcido cron <cron.json> [run flags]");
    }
    return {
      mode: "cron",
      file: path.resolve(file),
      cwd,
      reasoningEffort,
      model,
      approvalPolicy,
      sandbox,
    };
  }

  const goal = positional.join(" ").trim();

  if (!goal) {
    throw new Error("A goal string is required.");
  }

  if (mode === "orchestrate") {
    return { mode: "orchestrate", goal, cwd, reasoningEffort, model, approvalPolicy, sandbox, quiet };
  }

  return {
    mode,
    goal,
    cwd,
    reasoningEffort,
    model,
    approvalPolicy,
    sandbox,
    quiet,
    stream,
    resume,
  };
}

