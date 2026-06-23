/**
 * Tool-lifecycle hooks, ported provider-neutral from claw-rust
 * crates/runtime/src/hooks.rs. A HookRunner runs configured shell commands at
 * PreToolUse / PostToolUse / PostToolUseFailure, feeding each a JSON payload on
 * stdin + HOOK_* env vars, and interprets the result:
 *   - exit 0  -> allow (or deny if stdout JSON says so)
 *   - exit 2  -> deny
 *   - other   -> fail (and stop running further hooks)
 * stdout may be a JSON object carrying systemMessage / reason / decision /
 * hookSpecificOutput.{permissionDecision,permissionDecisionReason,updatedInput}.
 *
 * The command executor is injectable so tests stay hermetic (no real shell).
 */
import { spawn } from "node:child_process";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

export type HookConfig = {
  preToolUse: string[];
  postToolUse: string[];
  postToolUseFailure: string[];
};

export type PermissionDecision = "allow" | "deny" | "ask";

export type HookRunResult = {
  denied: boolean;
  failed: boolean;
  messages: string[];
  permissionDecision?: PermissionDecision;
  permissionReason?: string;
  updatedInput?: string;
};

export type HookCommandResult = { exitCode: number | null; stdout: string; stderr: string };

export type HookCommandExecutor = (
  command: string,
  env: Record<string, string>,
  stdin: string,
) => Promise<HookCommandResult>;

export function emptyHookConfig(): HookConfig {
  return { preToolUse: [], postToolUse: [], postToolUseFailure: [] };
}

function allow(messages: string[] = []): HookRunResult {
  return { denied: false, failed: false, messages };
}

type ParsedHookOutput = {
  messages: string[];
  deny: boolean;
  permissionDecision?: PermissionDecision;
  permissionReason?: string;
  updatedInput?: string;
};

export class HookRunner {
  private readonly config: HookConfig;
  private readonly execute: HookCommandExecutor;

  constructor(config: Partial<HookConfig> = {}, executor: HookCommandExecutor = defaultExecutor) {
    this.config = { ...emptyHookConfig(), ...config };
    this.execute = executor;
  }

  runPreToolUse(toolName: string, toolInput: string): Promise<HookRunResult> {
    return this.runCommands("PreToolUse", this.config.preToolUse, toolName, toolInput, undefined, false);
  }

  runPostToolUse(toolName: string, toolInput: string, toolOutput: string, isError: boolean): Promise<HookRunResult> {
    return this.runCommands("PostToolUse", this.config.postToolUse, toolName, toolInput, toolOutput, isError);
  }

  runPostToolUseFailure(toolName: string, toolInput: string, toolError: string): Promise<HookRunResult> {
    return this.runCommands("PostToolUseFailure", this.config.postToolUseFailure, toolName, toolInput, toolError, true);
  }

  private async runCommands(
    event: HookEvent,
    commands: string[],
    toolName: string,
    toolInput: string,
    toolOutput: string | undefined,
    isError: boolean,
  ): Promise<HookRunResult> {
    if (commands.length === 0) {
      return allow();
    }

    const payload = JSON.stringify(hookPayload(event, toolName, toolInput, toolOutput, isError));
    const env = hookEnv(event, toolName, toolInput, toolOutput, isError);
    const result = allow();

    for (const command of commands) {
      let exec: HookCommandResult;
      try {
        exec = await this.execute(command, env, payload);
      } catch (error) {
        result.failed = true;
        result.messages.push(`${event} hook \`${command}\` failed to start: ${error instanceof Error ? error.message : String(error)}`);
        return result;
      }

      const parsed = parseHookOutput(event, toolName, command, exec.stdout.trim(), exec.stderr.trim());
      mergeParsed(result, parsed);

      if (exec.exitCode === 0) {
        if (parsed.deny) {
          result.denied = true;
          return result;
        }
        continue;
      }
      if (exec.exitCode === 2) {
        result.denied = true;
        if (result.messages.length === 0) result.messages.push(`${event} hook denied tool \`${toolName}\``);
        return result;
      }
      // Any other (non 0/2) exit code, including null (signal), is a failure.
      result.failed = true;
      if (result.messages.length === 0) {
        result.messages.push(formatHookFailure(command, exec.exitCode, exec.stderr.trim()));
      }
      return result;
    }

    return result;
  }
}

function mergeParsed(target: HookRunResult, parsed: ParsedHookOutput): void {
  target.messages.push(...parsed.messages);
  if (parsed.permissionDecision !== undefined) target.permissionDecision = parsed.permissionDecision;
  if (parsed.permissionReason !== undefined) target.permissionReason = parsed.permissionReason;
  if (parsed.updatedInput !== undefined) target.updatedInput = parsed.updatedInput;
}

function parseHookOutput(
  event: HookEvent,
  toolName: string,
  command: string,
  stdout: string,
  stderr: string,
): ParsedHookOutput {
  const out: ParsedHookOutput = { messages: [], deny: false };
  if (stdout === "") return out;

  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    if (looksLikeJsonAttempt(stdout)) {
      out.messages.push(`hook_invalid_json: phase=${event} tool=${toolName} command=${preview(command)} stdout_preview=${preview(stdout)} stderr_preview=${preview(stderr) || "<empty>"}`);
      return out;
    }
    out.messages.push(stdout);
    return out;
  }

  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    out.messages.push(stdout);
    return out;
  }

  const obj = root as Record<string, unknown>;
  if (typeof obj.systemMessage === "string") out.messages.push(obj.systemMessage);
  if (typeof obj.reason === "string") out.messages.push(obj.reason);
  if (obj.continue === false || obj.decision === "block") out.deny = true;

  const specific = obj.hookSpecificOutput;
  if (typeof specific === "object" && specific !== null) {
    const s = specific as Record<string, unknown>;
    if (typeof s.additionalContext === "string") out.messages.push(s.additionalContext);
    if (s.permissionDecision === "allow" || s.permissionDecision === "deny" || s.permissionDecision === "ask") {
      out.permissionDecision = s.permissionDecision;
    }
    if (typeof s.permissionDecisionReason === "string") out.permissionReason = s.permissionDecisionReason;
    if (s.updatedInput !== undefined) out.updatedInput = JSON.stringify(s.updatedInput);
  }

  if (out.messages.length === 0) out.messages.push(stdout);
  return out;
}

function hookPayload(
  event: HookEvent,
  toolName: string,
  toolInput: string,
  toolOutput: string | undefined,
  isError: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    hook_event_name: event,
    tool_name: toolName,
    tool_input: parseToolInput(toolInput),
    tool_input_json: toolInput,
  };
  if (event === "PostToolUseFailure") {
    base.tool_error = toolOutput;
    base.tool_result_is_error = true;
  } else {
    base.tool_output = toolOutput ?? null;
    base.tool_result_is_error = isError;
  }
  return base;
}

function hookEnv(
  event: HookEvent,
  toolName: string,
  toolInput: string,
  toolOutput: string | undefined,
  isError: boolean,
): Record<string, string> {
  const env: Record<string, string> = {
    HOOK_EVENT: event,
    HOOK_TOOL_NAME: toolName,
    HOOK_TOOL_INPUT: toolInput,
    HOOK_TOOL_IS_ERROR: isError ? "1" : "0",
  };
  if (toolOutput !== undefined) env.HOOK_TOOL_OUTPUT = toolOutput;
  return env;
}

function parseToolInput(toolInput: string): unknown {
  try {
    return JSON.parse(toolInput);
  } catch {
    return { raw: toolInput };
  }
}

function looksLikeJsonAttempt(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[";
}

function formatHookFailure(command: string, code: number | null, stderr: string): string {
  let message = `Hook \`${command}\` exited with status ${code ?? "signal"}`;
  if (stderr) message += `: ${stderr}`;
  return message;
}

const PREVIEW_LIMIT = 160;
function preview(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const capped = [...trimmed].slice(0, PREVIEW_LIMIT).join("");
  const escaped = capped.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return [...trimmed].length > PREVIEW_LIMIT ? `${escaped}…` : escaped;
}

const defaultExecutor: HookCommandExecutor = (command, env, stdin) =>
  new Promise((resolve, reject) => {
    const [shell, flag] = process.platform === "win32" ? ["cmd", "/C"] : ["sh", "-lc"];
    const child = spawn(shell, [flag, command], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
