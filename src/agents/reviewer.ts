import type OpenAI from "openai";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";
import { runSolarChat } from "../solar/client.js";
import type { ExecutionPlan } from "./planner.js";
import type { ExecutionResult } from "./executor.js";

export type ReviewResult = {
  verdict: "approved" | "needs_attention";
  summary: string;
  concerns: string[];
};

const reviewResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "review_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: {
          type: "string",
          enum: ["approved", "needs_attention"],
        },
        summary: { type: "string" },
        concerns: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["verdict", "summary", "concerns"],
    },
  },
} as const;

export async function reviewExecution(
  client: OpenAI,
  goal: string,
  plan: ExecutionPlan,
  execution: ExecutionResult,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
  model?: string,
): Promise<ReviewResult> {
  const response = await runSolarChat(client, {
    model,
    reasoningEffort,
    temperature: 0.1,
    responseFormat: reviewResponseFormat,
    messages: [
      {
        role: "system",
        content:
          "You are a strict reviewer for a Solar-only CLI workflow. Evaluate whether the execution appears complete and coherent. Return JSON only.",
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Plan summary: ${plan.summary}`,
          "Plan steps:",
          ...plan.steps.map((step, index) => `${index + 1}. ${step.title} - ${step.goal}`),
          `Execution summary: ${execution.finish.summary}`,
          `Changed files: ${execution.finish.changed_files.join(", ") || "<none>"}`,
          `Suggested next steps: ${execution.finish.next_steps.join(", ") || "<none>"}`,
          "Transcript:",
          ...execution.transcript,
        ].join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Reviewer returned no content.");
  }

  return JSON.parse(content) as ReviewResult;
}
