import assert from "node:assert/strict";
import test from "node:test";

import { orchestrateGoal, formatOrchestrationResult } from "../dist/workflow/orchestrator.js";

function finishToolCall() {
  return {
    id: "call-finish",
    type: "function",
    function: {
      name: "finish",
      arguments: JSON.stringify({ summary: "agent done", changed_files: ["x.ts"], next_steps: ["a next step"] }),
    },
  };
}

// Mock client: the planner asks for a JSON plan (json_schema response format);
// every other agent runs a tool loop that we end immediately with `finish`.
function mockClient() {
  const counts = { planner: 0, loop: 0 };
  return {
    counts,
    async chat(options) {
      if (options.responseFormat?.json_schema?.name === "workflow_plan") {
        counts.planner += 1;
        return {
          choices: [{
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "the plan",
                requiresModification: true,
                explorationTargets: ["src"],
                executionSteps: ["edit x"],
                verificationCommands: ["npm test"],
              }),
            },
          }],
        };
      }
      counts.loop += 1;
      return { choices: [{ message: { role: "assistant", content: "", tool_calls: [finishToolCall()] } }] };
    },
  };
}

test("orchestrateGoal runs the planner -> explorer -> executor -> verifier -> reviewer pipeline", async () => {
  const client = mockClient();
  const result = await orchestrateGoal(client, "do the thing", process.cwd());

  assert.match(result.summary, /do the thing/);
  assert.equal(result.agentResults.length, 5);
  assert.deepEqual(
    result.agentResults.map((agent) => agent.role),
    ["planner", "explorer", "executor", "verifier", "reviewer"],
  );
  // planner = 1 JSON call; the four tool-loop agents each call once.
  assert.equal(client.counts.planner, 1);
  assert.equal(client.counts.loop, 4);
});

test("formatOrchestrationResult lists each agent + changed files", () => {
  const text = formatOrchestrationResult({
    summary: "Summary line",
    changedFiles: ["a.ts"],
    nextSteps: ["review"],
    agentResults: [{ role: "planner", summary: "planned" }],
  });
  assert.match(text, /Summary line/);
  assert.match(text, /\[planner\] planned/);
  assert.match(text, /Changed files: a\.ts/);
  assert.match(text, /Next steps: review/);
});
