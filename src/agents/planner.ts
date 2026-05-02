import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";
import type { WorkflowPlan } from "../workflow/types.js";

/**
 * Planner Agent.
 * Produces a structured plan from the user goal.
 */
export async function createPlan(
  client: OpenAI,
  goal: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<WorkflowPlan> {
  const response = await runSolarChat(client, {
    model,
    reasoningEffort,
    temperature: 0.2,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "workflow_plan",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            requiresModification: { type: "boolean" },
            explorationTargets: {
              type: "array",
              items: { type: "string" },
            },
            executionSteps: {
              type: "array",
              items: { type: "string" },
            },
            verificationCommands: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["summary", "requiresModification", "explorationTargets", "executionSteps", "verificationCommands"],
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "You are a planning agent in a Solar-only CLI. Break the user's goal into short actionable steps. Return JSON only.",
      },
      {
        role: "user",
        content: goal,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Planner returned no content.");
  }

  const plan = JSON.parse(content) as WorkflowPlan;
  // Ensure required fields exist
  if (!plan.summary) plan.summary = "";
  if (!plan.explorationTargets) plan.explorationTargets = [];
  if (!plan.executionSteps) plan.executionSteps = [];
  if (!plan.verificationCommands) plan.verificationCommands = [];
  if (!plan.requiresModification) plan.requiresModification = false;

  return plan;
}
