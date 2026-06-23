/**
 * `solarcido team <tasks.json>` — run several goals through the agent loop as a
 * batch, driven by the TaskRunner over a TaskRegistry. Each task runs the same
 * conversation loop as `solarcido run`; the workflow executor is injectable so
 * this is testable without hitting the API.
 */
import { readFileSync } from "node:fs";

import type { ReasoningEffort } from "../api/client.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { TaskRegistry, type TaskStatus } from "../runtime/task-registry.js";
import { TaskRunner, type TaskExecutor } from "../runtime/task-runner.js";
import { runWorkflow } from "./run-agent-loop.js";

export type TaskSpec = { prompt: string; description?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a tasks file: a JSON array, or `{tasks:[…]}`; items are strings or `{prompt,description}`. */
export function parseTasksFile(raw: string): TaskSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("tasks file is not valid JSON");
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.tasks)
      ? parsed.tasks
      : undefined;
  if (!list) {
    throw new Error('tasks file must be a JSON array or an object with a "tasks" array');
  }

  const specs: TaskSpec[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim()) specs.push({ prompt: item.trim() });
    } else if (isRecord(item) && typeof item.prompt === "string" && item.prompt.trim()) {
      specs.push({
        prompt: item.prompt.trim(),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      });
    }
  }

  if (specs.length === 0) {
    throw new Error("tasks file contains no tasks");
  }
  return specs;
}

export function loadTasksFile(filePath: string): TaskSpec[] {
  return parseTasksFile(readFileSync(filePath, "utf8"));
}

export type TeamTaskResult = { prompt: string; status: TaskStatus; output: string };
export type TeamReport = { results: TeamTaskResult[]; completed: number; failed: number };

export type RunTeamOptions = {
  tasks: TaskSpec[];
  cwd?: string;
  reasoningEffort?: ReasoningEffort;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  concurrency?: number;
  quiet?: boolean;
};

/** Build the default executor that runs each task's prompt through the agent loop. */
export function makeWorkflowExecutor(options: RunTeamOptions): TaskExecutor {
  return async (task) => {
    const summary = await runWorkflow({
      goal: task.prompt,
      cwd: options.cwd,
      reasoningEffort: options.reasoningEffort,
      model: options.model,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      quiet: options.quiet ?? true,
    });
    const changed =
      summary.finish.changed_files.length > 0 ? ` [changed: ${summary.finish.changed_files.join(", ")}]` : "";
    return { ok: true, output: `${summary.finish.summary}${changed}` };
  };
}

/** Run all tasks via the TaskRunner, returning a per-task report. */
export async function runTeam(
  options: RunTeamOptions,
  executor: TaskExecutor = makeWorkflowExecutor(options),
): Promise<TeamReport> {
  const registry = new TaskRegistry();
  for (const spec of options.tasks) {
    registry.create(spec.prompt, spec.description);
  }
  const runner = new TaskRunner(registry, executor);
  const tasks = await runner.runPending({ concurrency: options.concurrency });
  const results: TeamTaskResult[] = tasks.map((task) => ({
    prompt: task.prompt,
    status: task.status,
    output: task.output,
  }));
  return {
    results,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

export function formatTeamReport(report: TeamReport): string {
  const lines = [`Team: ${report.completed} completed, ${report.failed} failed`];
  for (const result of report.results) {
    lines.push(`  [${result.status}] ${result.prompt}`);
    if (result.output) {
      lines.push(`        ${result.output.replace(/\n/g, "\n        ")}`);
    }
  }
  return lines.join("\n");
}
