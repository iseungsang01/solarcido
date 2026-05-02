# Multi-Agent Orchestration Spec

This document defines Solarcido's target multi-agent workflow. The goal is to
avoid filling one long model context with every file read, command output, and
tool transcript. Solarcido should instead run small role-specific agent loops
and merge their compact structured results.

This is a design target. Implement it incrementally and keep the existing
single-loop workflow available until the orchestrated path is stable.

## Goals

- Keep each model context small by isolating work into short-lived agents.
- Pass compact structured results between agents instead of full transcripts.
- Preserve predictable local coding behavior: inspect, edit, verify, review,
  then finish.
- Make read-only investigation safe to parallelize later.
- Keep file writes centralized at first to avoid edit conflicts.
- Add context compaction inside an agent only as a safety valve, not as the
  primary context-management strategy.

## Non-Goals

- Do not build a general cloud agent platform.
- Do not add background daemon behavior.
- Do not allow agents to operate outside the selected `cwd`.
- Do not introduce parallel file editing in the first implementation.
- Do not store unbounded full agent transcripts in session metadata.
- Do not add MCP as part of this feature; MCP remains a separate roadmap item.

## Architecture

Target modules:

```txt
src/agents/
  types.ts
  agent-loop.ts
  planner.ts
  explorer.ts
  executor.ts
  verifier.ts
  reviewer.ts
  context-budget.ts

src/workflow/
  orchestrator.ts
  run-agent-loop.ts
```

Ownership:

- `run-agent-loop.ts` remains the CLI-facing workflow entrypoint.
- `orchestrator.ts` coordinates agent calls and owns workflow-level decisions.
- `agent-loop.ts` owns the reusable model/tool loop for a single agent.
- `context-budget.ts` owns token estimation and per-agent compaction.
- `planner.ts` produces a structured plan from the user goal.
- `explorer.ts` investigates the repository using read-only tools.
- `executor.ts` makes edits and may run focused commands.
- `verifier.ts` runs verification commands and summarizes failures.
- `reviewer.ts` checks whether the result satisfies the original goal.

Boundary rules:

- Agent modules may call model APIs through `src/solar/client.ts`.
- Agent modules may call tools only through `src/tools/registry.ts`.
- Tool implementation remains in `src/tools/`.
- The orchestrator must not perform file or process side effects directly.
- Agent-to-agent communication must use structured summaries, not raw
  transcripts.

## Workflow

Default sequential flow:

```txt
User Goal
  -> Orchestrator
  -> Planner Agent
  -> Explorer Agent
  -> Executor Agent, only if changes are needed
  -> Verifier Agent
  -> Reviewer Agent
  -> finish
```

The first implementation should be sequential. Later versions may run multiple
read-only explorer agents in parallel when their scopes are disjoint.

## Shared Types

Target TypeScript shape:

```ts
export type AgentRole =
  | "planner"
  | "explorer"
  | "executor"
  | "verifier"
  | "reviewer";

export type AgentResult = {
  role: AgentRole;
  summary: string;
  findings: string[];
  changedFiles: string[];
  evidence: string[];
  risks: string[];
  nextSteps: string[];
};

export type WorkflowPlan = {
  summary: string;
  requiresModification: boolean;
  explorationTargets: string[];
  executionSteps: string[];
  verificationCommands: string[];
};

export type OrchestrationResult = {
  summary: string;
  changedFiles: string[];
  nextSteps: string[];
  agentResults: AgentResult[];
};
```

Rules:

- `summary` should be concise and directly useful to the next agent.
- `findings` should contain durable facts, not raw file dumps.
- `evidence` should reference files, line numbers, command names, or test names.
- `changedFiles` should contain workspace-relative paths.
- `risks` should include uncertainty, failed checks, or unverified assumptions.
- `nextSteps` should be actionable and short.

## Agent Contracts

### Planner Agent

Inputs:

- User goal.
- Working directory path.
- Current model and reasoning settings.

Allowed tools:

- None by default.
- Optional read-only tools only if the goal is ambiguous and local structure is
  needed.

Output:

- `WorkflowPlan`.

The planner should decide whether code or documentation modification is likely
required. It should not make edits.

### Explorer Agent

Inputs:

- User goal.
- `WorkflowPlan`.
- Optional prior `AgentResult` values.

Allowed tools:

- `list_files`
- `search_files`
- `read_file`

Output:

- `AgentResult` with role `explorer`.

The explorer should find relevant files, summarize implementation constraints,
and identify likely edit locations. It must not modify files or run mutating
commands.

Parallelization rule:

- Multiple explorer agents may run in parallel only when each explorer has a
  distinct read-only scope.

### Executor Agent

Inputs:

- User goal.
- `WorkflowPlan`.
- Explorer result summaries.
- Current sandbox and approval policy.

Allowed tools:

- `list_files`
- `search_files`
- `read_file`
- `edit_file`
- `write_file`
- `run_command`, when needed for focused inspection or generated-code checks.

Output:

- `AgentResult` with role `executor`.

The executor is the only agent that should make file changes in the first
implementation. It should prefer focused edits over full-file rewrites.

### Verifier Agent

Inputs:

- User goal.
- `WorkflowPlan`.
- Executor result.
- Suggested verification commands.

Allowed tools:

- `run_command`
- Read-only file tools if needed to interpret failures.

Output:

- `AgentResult` with role `verifier`.

The verifier should run the smallest relevant verification commands. Command
stdout and stderr must be summarized before returning to the orchestrator.

### Reviewer Agent

Inputs:

- User goal.
- Plan.
- Explorer, executor, and verifier results.

Allowed tools:

- Read-only tools only when needed to resolve a specific uncertainty.

Output:

- `AgentResult` with role `reviewer`.
- A final recommendation for the orchestrator.

The reviewer should focus on missed requirements, likely regressions, missing
tests, and whether the workflow can safely finish.

## Context Management

Primary strategy:

- Keep agent contexts isolated and short-lived.
- Pass only `WorkflowPlan` and `AgentResult` values between agents.
- Do not pass raw tool transcripts to the orchestrator.

Secondary safety strategy:

- Each agent loop tracks an estimated context budget.
- The default context window is `131072` tokens.
- When the estimated context reaches 90% of the window, the agent must compact
  its local messages before sending the next model request.

Compaction must preserve:

- User goal.
- Agent role and current task.
- Plan summary.
- Files inspected.
- Key findings.
- File changes made by the current agent.
- Commands run and whether they passed or failed.
- Open risks and remaining steps.

Compaction should drop:

- Full file dumps already summarized.
- Old search results that have been converted into findings.
- Long command stdout and stderr after failure causes are summarized.
- Repeated assistant narration.

Token estimation:

- Use a deterministic approximation until provider token counts are available.
- A conservative first implementation may estimate one token per four
  characters plus a fixed per-message overhead.
- The estimator must be covered by unit tests so threshold behavior is stable.

## Tool Output Policy

Agent loops may preserve full tool output inside the current agent until the
agent finishes or compacts. The orchestrator must receive only structured
summaries.

Long output handling should be added after the basic orchestrator works:

- Cap model-visible command output.
- Cap broad `read_file` output unless the model requested a focused line
  window.
- Store oversized output behind a short-lived handle if later retrieval is
  needed.

Do not change existing tool contracts until the orchestrated workflow is wired
and tested.

## Session Metadata

Session metadata should store compact orchestration results:

- Session id.
- Goal.
- Cwd.
- Selected model and settings.
- Status.
- Plan summary.
- Agent result summaries.
- Changed files.
- Verification status.
- Final summary and next steps.
- Failure message, if any.

Session metadata must not store:

- API keys or secrets.
- Full agent transcripts.
- Unbounded command output.
- Full file contents read by agents.

## Failure Handling

- If planning fails, the workflow fails before any edits.
- If exploration fails, the orchestrator may retry with a narrower scope once.
- If execution fails after partial edits, the verifier and reviewer should still
  run when safe so the final output can explain the partial state.
- If verification fails, the reviewer decides whether the executor should retry
  or whether the workflow should finish with explicit risks.
- Tool errors should remain recoverable model-visible results inside the agent
  loop unless they indicate a workflow-level failure.

## Implementation Phases

1. Add shared types and context-budget utilities.
2. Add a reusable single-agent loop without changing default behavior.
3. Add the orchestrator behind an internal code path.
4. Convert planner, explorer, executor, verifier, and reviewer to structured
   contracts.
5. Switch `runWorkflow` to the orchestrator once tests cover the sequential
   path.
6. Add 90% per-agent compaction.
7. Add optional parallel read-only explorers.
8. Add bounded tool output handles if token pressure remains high.

## Verification

Minimum tests:

- Planner output validation.
- Agent result shape validation.
- Orchestrator sequential flow with mocked agent functions.
- Context budget threshold at 90%.
- Compaction keeps required facts and removes long raw output.
- Executor is the only first-phase agent allowed to call mutating tools.

Manual checks:

```bash
npm run typecheck
npm test
npm run build
node dist/index.js --help
```
