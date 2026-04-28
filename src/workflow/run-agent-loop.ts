import path from "node:path";

import { createSolarClient } from "../solar/client.js";
import { DEFAULT_MAX_STEPS, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { createPlan } from "../agents/planner.js";
import { executePlan } from "../agents/executor.js";
import { reviewExecution } from "../agents/reviewer.js";

export type RunWorkflowOptions = {
  goal: string;
  cwd?: string;
  maxSteps?: number;
  reasoningEffort?: ReasoningEffort;
};

export async function runWorkflow(options: RunWorkflowOptions): Promise<void> {
  const client = createSolarClient();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;

  console.log(`\n[planner] Goal: ${options.goal}`);
  const plan = await createPlan(client, options.goal, reasoningEffort);
  console.log(`[planner] ${plan.summary}`);

  for (const [index, step] of plan.steps.entries()) {
    console.log(`  ${index + 1}. ${step.title} — ${step.goal}`);
  }

  console.log(`\n[executor] Working in ${cwd}`);
  const execution = await executePlan(client, options.goal, plan, cwd, maxSteps, reasoningEffort);
  console.log(`[executor] ${execution.finish.summary}`);

  if (execution.finish.changed_files.length > 0) {
    console.log(`[executor] Changed files: ${execution.finish.changed_files.join(", ")}`);
  }

  console.log(`\n[reviewer] Checking execution quality...`);
  const review = await reviewExecution(client, options.goal, plan, execution, reasoningEffort);
  console.log(`[reviewer] ${review.verdict}: ${review.summary}`);

  if (review.concerns.length > 0) {
    console.log("[reviewer] Concerns:");
    for (const concern of review.concerns) {
      console.log(`  - ${concern}`);
    }
  }

  if (execution.finish.next_steps.length > 0) {
    console.log("\n[next]");
    for (const step of execution.finish.next_steps) {
      console.log(`  - ${step}`);
    }
  }
}

export async function printPlanOnly(options: RunWorkflowOptions): Promise<void> {
  const client = createSolarClient();
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const plan = await createPlan(client, options.goal, reasoningEffort);

  console.log(`\n[planner] ${plan.summary}`);
  for (const [index, step] of plan.steps.entries()) {
    console.log(`  ${index + 1}. ${step.title} — ${step.goal}`);
  }
}
