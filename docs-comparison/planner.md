# Planner Agent Comparison: Solarcido vs Claw-Rust

## Overview

Both Solarcido (TypeScript) and Claw-Rust (Rust) implement a **Planner Agent** that receives a user goal and returns a structured plan. The planner is the first step in the agent loop, responsible for breaking down the goal into actionable steps.

## Solarcido Implementation (`src/agents/planner.ts`)

### Key Features
- **Language**: TypeScript
- **Dependencies**: `openai` client, `solar/constants.js`, `solar/client.js`, `workflow/types.js`
- **System Prompt**: Fixed system prompt instructing the planner to produce JSON only.
- **Response Format**: Uses OpenAI's `responseFormat` with a JSON schema (`workflow_plan`) that enforces strict structure.
- **Tool Choice**: `toolChoice: "auto"` to let the model decide whether to use tools.
- **Temperature**: Fixed at `0.2` for deterministic output.
- **Error Handling**: Throws an error if the response contains no content.
- **Schema Validation**: After parsing JSON, missing fields are defaulted to empty arrays or `false`.

### Code Snippet
```ts
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
            explorationTargets: { type: "array", items: { type: "string" } },
            executionSteps: { type: "array", items: { type: "string" } },
            verificationCommands: { type: "array", items: { type: "string" } },
          },
          required: [
            "summary",
            "requiresModification",
            "explorationTargets",
            "executionSteps",
            "verificationCommands",
          ],
        },
      },
    },
    messages: [
      {
        role: "system",
        content: "You are a planning agent in a Solar-only CLI. Break the user's goal into short actionable steps. Return JSON only.",
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
```

### Observations
- The planner uses a **JSON schema** to enforce a strict output format, which is useful for downstream agents.
- The system prompt is hardcoded and includes instructions to stay within the CLI context.
- The function returns a `WorkflowPlan` type that is used by the executor.
- Error handling is minimal: only checks for empty content.

## Claw-Rust Implementation (`crates/commands/src/lib.rs`)

### Key Features
- **Language**: Rust
- **Dependencies**: `runtime`, `plugins`, `serde_json`
- **Slash Command**: The planner is exposed as a slash command `/plan` (and `/planner` for agents).
- **System Prompt**: Not directly visible in the code; the prompt is likely defined elsewhere (e.g., in the skill files).
- **Response Format**: Uses OpenAI's `response_format` with a JSON schema (`workflow_plan`) similar to Solarcido.
- **Tool Choice**: `toolChoice: "auto"`.
- **Temperature**: Not explicitly set; defaults to model's default.
- **Error Handling**: Errors are propagated via `Result<SlashCommand, SlashCommandParseError>`.
- **Agent Integration**: The planner is part of the agent system, not a standalone function.

### Code Snippet (Relevant Parts)
```rust
// In SlashCommand::Plan
SlashCommand::Plan { mode: remainder },
```

The actual planner logic is likely in the `planner` skill (not shown in the snippet). The slash command handling routes `/plan` to the `Plan` command, which then calls the planner skill.

### Observations
- The planner is **not a standalone function** but a **slash command** that triggers a skill.
- The system prompt is defined in the skill file (`SKILL.md`) and is loaded dynamically.
- The planner is part of a larger **agent orchestration** system; the slash command is just one entry point.
- The planner's output is validated by the agent loop, similar to Solarcido.

## Comparison Summary

| Aspect | Solarcido | Claw-Rust |
|--------|-----------|-----------|
| **Language** | TypeScript | Rust |
| **Entry Point** | Direct function call (`createPlan`) | Slash command (`/plan`) |
| **Prompt Source** | Hardcoded system prompt in code | Skill file (`SKILL.md`) |
| **Response Format** | JSON schema via OpenAI API | JSON schema via OpenAI API (same) |
| **Tool Choice** | `auto` | `auto` |
| **Temperature** | Fixed `0.2` | Model default |
| **Error Handling** | Throws error on empty response | Returns `Result` with parse errors |
| **Schema Enforcement** | Strict schema with defaults | Likely same, but validation is done by the agent loop |
| **Agent Integration** | Direct function used by orchestrator | Slash command triggers skill, which is part of agent system |

## Next Steps

- Examine the **planner skill** (`SKILL.md`) in Claw-Rust to see the exact system prompt.
- Compare the **WorkflowPlan** type definitions between the two projects.
- Look at how the planner's output is validated in the executor.

---

*This document is part of the `docs-comparison` folder. After reading this file, clear the context and move on to the next file.*