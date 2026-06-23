/**
 * `solarcido cron <cron.json>` — a minimal in-process cron daemon. It loads
 * named scheduled goals, then on each minute fires the jobs whose 5-field cron
 * schedule is due, running each goal through the agent loop. The pure schedule
 * logic lives in runtime/cron/*; this module adds config loading, a testable
 * single-tick runner, and the (side-effecting) daemon loop.
 */
import { readFileSync } from "node:fs";

import type { ReasoningEffort } from "../api/client.js";
import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { dueJobs, validateCronJobs, type CronJob } from "../runtime/cron/scheduler.js";
import { runWorkflow } from "./run-agent-loop.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a cron file: a JSON array or `{jobs:[…]}` of `{name,schedule,goal}`. */
export function parseCronJobs(raw: string): CronJob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("cron file is not valid JSON");
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : undefined;
  if (!list) {
    throw new Error('cron file must be a JSON array or an object with a "jobs" array');
  }

  const jobs: CronJob[] = [];
  for (const item of list) {
    if (
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.schedule === "string" &&
      typeof item.goal === "string"
    ) {
      jobs.push({ name: item.name, schedule: item.schedule, goal: item.goal });
    }
  }
  if (jobs.length === 0) {
    throw new Error("cron file contains no valid {name,schedule,goal} jobs");
  }
  return jobs;
}

export function loadCronJobs(filePath: string): CronJob[] {
  return parseCronJobs(readFileSync(filePath, "utf8"));
}

/**
 * Fire every job due at `at`, via `runJob`. Returns the jobs that fired.
 * Pure-ish + injectable so the daemon's per-minute behavior is testable.
 */
export async function runCronTick(
  jobs: CronJob[],
  at: Date,
  runJob: (job: CronJob) => Promise<void>,
): Promise<CronJob[]> {
  const due = dueJobs(jobs, at);
  for (const job of due) {
    await runJob(job);
  }
  return due;
}

export type CronDaemonOptions = {
  jobs: CronJob[];
  cwd?: string;
  reasoningEffort?: ReasoningEffort;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  /** Poll interval in ms (default 30s). */
  intervalMs?: number;
  /** Injectable clock for testing; defaults to real time. */
  now?: () => Date;
  /** Injectable job runner; defaults to running the goal through the agent loop. */
  runJob?: (job: CronJob) => Promise<void>;
};

/**
 * Run the cron daemon loop. Blocks until the process is killed. Skips invalid
 * schedules (reported once) and de-duplicates firings within the same minute.
 */
export async function runCronDaemon(options: CronDaemonOptions): Promise<void> {
  const { ok, errors } = validateCronJobs(options.jobs);
  for (const error of errors) {
    console.log(`[cron] skipping invalid job ${error.name}: ${error.error}`);
  }
  if (ok.length === 0) {
    console.log("[cron] no valid jobs to schedule.");
    return;
  }

  const now = options.now ?? (() => new Date());
  const runJob =
    options.runJob ??
    (async (job: CronJob) => {
      console.log(`[cron] firing ${job.name}`);
      try {
        await runWorkflow({
          goal: job.goal,
          cwd: options.cwd,
          reasoningEffort: options.reasoningEffort,
          model: options.model,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          quiet: true,
        });
      } catch (error) {
        console.log(`[cron] ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  console.log(`[cron] scheduling ${ok.length} job(s); press Ctrl-C to stop.`);

  let lastMinute = "";
  const tick = async () => {
    const at = now();
    const minuteKey = at.toISOString().slice(0, 16);
    if (minuteKey === lastMinute) return;
    lastMinute = minuteKey;
    await runCronTick(ok, at, runJob);
  };

  await tick();
  await new Promise<void>(() => {
    setInterval(() => {
      void tick();
    }, options.intervalMs ?? 30_000);
  });
}
