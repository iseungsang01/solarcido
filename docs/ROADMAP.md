# Solarcido Implementation Roadmap

This roadmap turns `docs/SPEC.md` into implementation phases. Build in this order unless there is a strong reason to change the sequence.

## Phase 0: Current Baseline

Status: done.

- CLI supports interactive mode and `run`.
- Workflow loop can call model tools.
- Tools support listing, reading, searching, writing, focused editing, commands, and finish summaries.
- Command failures return model-readable output instead of crashing the workflow.
- Project-level agent rules live in `AGENTS.md`.
- Tight architecture spec lives in `docs/SPEC.md`.

Exit checks:

```bash
npm run typecheck
npm run build
node dist/index.js --help
```

## Phase 1: Stabilize Core Contracts

Status: done.

Goal: make the current behavior safer and easier to test before adding larger features.

Tasks:

- Add tests for `parseCliArgs`.
- Add tests for workspace path boundary checks in file tools.
- Add tests for `edit_file` ambiguity handling.
- Add tests for `run_command` returning `exit_code`, `stdout`, and `stderr`.
- Move repeated tool argument validation into a small registry-local pattern only if it reduces duplication clearly.
- Confirm README and CLI help match exactly.

Non-goals:

- Do not add config yet.
- Do not add MCP yet.
- Do not add a new UI framework.

Exit checks:

```bash
npm run typecheck
npm run build
node dist/index.js --help
```

Test command:

```bash
npm test
```

## Phase 2: Config System

Status: done.

Goal: add persistent defaults without making CLI behavior surprising.

Target module:

```txt
src/config/
  load-config.ts
  schema.ts
```

Target config path:

```txt
~/.solarcido/config.json
```

Target shape:

```json
{
  "model": "solar-pro3-260323",
  "reasoningEffort": "high",
  "approvalPolicy": "on-failure",
  "sandbox": "workspace-write",
  "quiet": false
}
```

Implementation rules:

- Validate config before use.
- Reject unknown keys with a clear error.
- Keep config optional; missing config should use built-in defaults.
- Keep CLI flags highest precedence.
- Do not mutate config from interactive session commands.

CLI additions:

```txt
solarcido config get [key]
solarcido config set <key> <value>
solarcido config path
```

Exit checks:

```bash
npm run typecheck
npm run build
node dist/index.js --help
```

Documentation updates:

- `README.md`
- `docs/SPEC.md`, only if the schema changes from the target above

## Phase 3: Approval Policy

Status: done.

Goal: prevent surprising command execution while preserving useful automation.

Target policies:

```txt
never
on-failure
on-request
```

Implementation rules:

- Add a command classifier before `runCommand`.
- Mark read-only commands as lower risk.
- Mark write, delete, install, network, package-publish, git-push, and privilege-changing commands as risky.
- `on-request` must prompt before risky commands.
- `on-failure` may ask before retrying after a failed command if elevated behavior is available later.
- `never` must not mean unsafe full access; it only means "do not prompt within the current implemented sandbox limits."

Target modules:

```txt
src/approvals/
  policy.ts
  classify-command.ts
  prompt.ts
```

Exit checks:

```bash
npm run typecheck
npm run build
```

Manual checks:

```bash
solarcido run "show files" --quiet
solarcido run "run npm build" --quiet
```

## Phase 4: Sandbox Semantics

Status: done for documented logical modes. OS-level process isolation is not implemented.

Goal: make the documented sandbox modes real enough to rely on.

Target modes:

```txt
read-only
workspace-write
```

Implementation rules:

- `read-only` disables `write_file` and `edit_file`.
- `workspace-write` allows writes only under `cwd`.
- `danger-full-access` remains unimplemented unless explicitly approved in a future spec update.
- Command execution must receive sandbox mode context.
- User-facing help must not imply OS-level isolation unless it exists.

Exit checks:

```bash
npm run typecheck
npm run build
```

## Phase 5: Better Agent Sessions

Status: done for compact session metadata. Full transcript storage remains out of scope.

Goal: make sessions inspectable and resumable enough for real work.

Target features:

- Assign a session id to each workflow run.
- Store compact session metadata under `~/.solarcido/sessions/`.
- Add `solarcido sessions list`.
- Add `solarcido sessions show <id>`.

Implementation rules:

- Never store API keys.
- Redact environment values that look secret-like.
- Keep session files small; do not dump huge tool outputs without limits.

## Phase 6: Multi-Agent Orchestration

Status: next.

Goal: reduce context pressure by replacing the single long-lived workflow loop
with short-lived role-specific agents coordinated by an orchestrator.

Design document:

```txt
docs/MULTI_AGENT_ORCHESTRATION.md
```

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
```

Implementation rules:

- Keep `src/workflow/run-agent-loop.ts` as the CLI-facing wrapper.
- Implement the first orchestrator as a sequential pipeline:
  planner -> explorer -> executor -> verifier -> reviewer.
- Keep file writes centralized in the executor agent.
- Use read-only tools for explorer and reviewer unless a later phase explicitly expands their permissions.
- Pass structured `WorkflowPlan` and `AgentResult` objects between agents.
- Do not pass raw tool transcripts between agents.
- Do not store full agent transcripts in session metadata.
- Add per-agent context estimation and compact local agent messages when the
  estimated context reaches 90% of the configured context window.
- Do not add parallel explorers until the sequential path is tested.

Milestones:

1. Add shared agent types and shape validation tests.
2. Add context budget estimation tests.
3. Add a reusable single-agent loop that preserves current tool behavior.
4. Add planner and explorer agents.
5. Add executor, verifier, and reviewer agents.
6. Add `orchestrator.ts` and test the sequential workflow with mocked agents.
7. Switch `runWorkflow` to the orchestrator.
8. Add 90% per-agent compaction before model requests.
9. Add optional parallel read-only explorers.

Exit checks:

```bash
npm run typecheck
npm test
npm run build
node dist/index.js --help
```

Non-goals:

- Do not add MCP in this phase.
- Do not add parallel mutating agents.
- Do not change CLI flags unless a specific user-visible orchestration mode is
  added and documented.
- Do not change tool output truncation behavior until the basic orchestrator is
  stable.

## Phase 7: MCP Foundation

Status: planned.

Goal: prepare MCP without spreading MCP-specific logic through the whole app.

Target modules:

```txt
src/mcp/
  server-config.ts
  connection-manager.ts
  tool-adapter.ts
```

Implementation rules:

- MCP server config belongs in Solarcido config.
- Mutating MCP tools require explicit approval policy.
- Tool list mutation and call mutation must stay centralized in `connection-manager.ts`.
- Do not add MCP until config and approval policy are stable.

## Build Rule

For each phase:

1. Keep the change small enough to review.
2. Update docs in the same change as behavior.
3. Run the phase exit checks.
4. Do not move to the next phase if the current phase leaves broken help text, broken typecheck, or unclear command behavior.
