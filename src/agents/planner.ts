import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";

export type PlanStep = {
  title: string;
  goal: string;
};

export type ExecutionPlan = {
  summary: string;
  steps: PlanStep[];
};

const plannerResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "execution_plan",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
            },
            required: ["title", "goal"],
          },
        },
      },
      required: ["summary", "steps"],
    },
  },
} as const;

export async function createPlan(
  client: OpenAI,
  goal: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): Promise<ExecutionPlan> {
  const response = await runSolarChat(client, {
    reasoningEffort,
    temperature: 0.2,
    responseFormat: plannerResponseFormat,
    messages: [
      {
        role: "system",
        content:
          "You are a planning agent for a Solar-only coding CLI. Break the user's goal into short actionable steps. Return JSON only.",
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

  return JSON.parse(content) as ExecutionPlan;
}
