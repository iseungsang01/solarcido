# Solarcido TypeScript Runtime Restructure Plan

## Goal

Restructure `solarcido/src` so that it becomes a TypeScript / Upstage Solar port of the architecture represented by `solarcido/claw-rust`, rather than a small MVP coding CLI.

The goal is not to preserve the current `src` architecture. The goal is to rebuild the TypeScript implementation around the same conceptual boundaries as `claw-rust`:

- `api`
- `runtime`
- `commands`
- `tools`
- `plugins`
- `telemetry`
- `cli`

Existing useful code should be reused where possible, but the current `workflow/agents`-centered structure should not remain the long-term architecture.

## Current Problem

The current `src` structure is organized around a small coding-agent MVP:

```txt
src/
  cli.ts
  config/
  solar/
  tools/
  workflow/
  agents/
  sessions/
```

This does not match the intended target architecture. In particular:

1. `workflow/run-agent-loop.ts` acts like the central execution entrypoint.
2. `workflow/orchestrator.ts` tries to implement a planner/explorer/executor/verifier/reviewer pipeline, but this is not the same architecture as `claw-rust`.
3. `tools/registry.ts` mixes tool schema definition, dispatch, permission checks, and execution.
4. Tool permissions are not represented as first-class metadata on each tool.
5. Read-only agents can still receive write-capable tool definitions unless manually restricted.
6. The model API layer is named `solar`, but the target architecture should use a provider-oriented `api` layer.
7. Slash command definitions are embedded in CLI help / interactive code rather than owned by a `commands` module.
8. There is no real `runtime` module that owns conversation loop, prompt assembly, session state, permissions, compaction, and tool execution.
9. Existing multi-agent files appear transitional and should not be treated as the architectural foundation.

## Target Architecture

Restructure `src` toward this layout:

```txt
src/
  api/
    client.ts
    error.ts
    http-client.ts
    sse.ts
    types.ts
    providers/
      upstage.ts
      openai-compat.ts

  runtime/
    conversation.ts
    session.ts
    prompt.ts
    compact.ts
    config.ts
    permissions.ts
    permission-enforcer.ts
    sandbox.ts
    file-ops.ts
    bash.ts
    usage.ts

  tools/
    specs.ts
    registry.ts
    executor.ts
    search.ts
    builtin/
      bash.ts
      read-file.ts
      write-file.ts
      edit-file.ts
      grep-search.ts
      glob-search.ts
      finish.ts

  commands/
    specs.ts
    registry.ts
    dispatcher.ts
    builtins/
      help.ts
      status.ts
      sandbox.ts
      compact.ts
      model.ts
      permissions.ts
      clear.ts
      config.ts
      sessions.ts
      diff.ts
      doctor.ts

  plugins/
    types.ts
    manager.ts

  telemetry/
    tracer.ts
    usage.ts

  cli/
    main.ts
    parse-args.ts
    repl.ts
```

This structure intentionally mirrors the conceptual division in `claw-rust`:

| claw-rust crate | TypeScript target |
|---|---|
| `crates/api` | `src/api` |
| `crates/runtime` | `src/runtime` |
| `crates/tools` | `src/tools` |
| `crates/commands` | `src/commands` |
| `crates/plugins` | `src/plugins` |
| `crates/telemetry` | `src/telemetry` |
| CLI binary layer | `src/cli` |

## Non-Goals For This Refactor

Do not implement the entire Claw feature surface in this first restructuring pass.

Do not implement yet:

- MCP
- plugin installation
- worker registry
- task registry
- cron/team registry
- OAuth
- remote gateway
- branch lock
- policy engine
- notebook editing
- web search / web fetch
- background tasks
- multi-worker execution

The current phase is about architecture and core runtime parity, not full feature parity.

## Guiding Principles

1. Preserve useful behavior, not current file boundaries.
2. Prefer moving and splitting existing code over rewriting logic from scratch.
3. Keep each step small enough to typecheck and test.
4. Do not keep dead transitional code.
5. Do not make `workflow/orchestrator.ts` the architectural center.
6. Tool permissions must be represented at the tool specification level.
7. Runtime must own the conversation loop.
8. CLI must be a thin layer over runtime and command dispatch.
9. Provider-specific code belongs under `api/providers`.
10. The final structure should make later MCP/plugin/task/worker work possible without another full rewrite.

## Phase 0 — Baseline And Safety

Status: completed for Phase 0 scope on `refactor/claw-rust-ts-structure`.

### Objective

Create a refactor branch and record current verification status.

### Tasks

- [x] Create a branch:

```bash
git checkout -b refactor/claw-rust-ts-structure
```

- [x] Run current checks and record failures:

```bash
npm run typecheck
npm test
npm run build
```

- [x] Do not try to fix all current failures in this phase.

- [x] Add a short note to `docs/ROADMAP.md` or a new implementation note saying that the TypeScript implementation is being restructured toward the `claw-rust` reference architecture.

### Exit Criteria

- Branch exists.
- Current verification output is known.
- No broad rewrite has happened yet.

## Phase 1 — Create Target Module Skeleton

Status: completed for skeleton-only scope; no runtime behavior changed.

### Objective

Create the target directory structure without changing runtime behavior yet.

### Tasks

- [x] Create these directories and placeholder index files where useful:

```txt
src/api/
src/api/providers/
src/runtime/
src/tools/
src/tools/builtin/
src/commands/
src/commands/builtins/
src/plugins/
src/telemetry/
src/cli/
```

Recommended placeholder files:

```txt
src/api/types.ts
src/runtime/permissions.ts
src/tools/specs.ts
src/tools/registry.ts
src/commands/specs.ts
src/plugins/types.ts
src/telemetry/usage.ts
src/cli/parse-args.ts
```

### Rules

- [x] Do not delete existing files yet.
- [x] Do not move large logic yet.
- [x] Keep TypeScript compiling if possible.
- [x] If placeholders create unused import issues, avoid exporting them until needed.
- [x] Existing `src/tools/registry.ts` was intentionally left unchanged.

Completed placeholder files:

```txt
src/api/types.ts
src/api/providers/index.ts
src/runtime/permissions.ts
src/tools/specs.ts
src/tools/builtin/index.ts
src/commands/specs.ts
src/commands/builtins/index.ts
src/plugins/types.ts
src/telemetry/usage.ts
src/cli/parse-args.ts
```

### Exit Criteria

```bash
npm run typecheck
```

should either pass or fail only on pre-existing known errors.

Result: `npm run typecheck`, `npm test`, and `npm run build` still fail only at the pre-existing `src/workflow/agent-loop.ts` syntax errors recorded during Phase 0 baseline.

## Phase 0/1 Implementation Log

- Created branch `refactor/claw-rust-ts-structure`.
- Installed missing npm dependencies so the local TypeScript compiler resolves.
- Recorded baseline verification: `npm run typecheck`, `npm test`, and `npm run build` all fail with TypeScript syntax errors in `src/workflow/agent-loop.ts`.
- Added an architecture restructure note to `docs/ROADMAP.md`.
- Created a context snapshot at `.omx/context/solarcido-claw-rust-port-20260523T111242Z.md`.
- Added target module skeleton placeholders only; no existing runtime imports, CLI behavior, tool behavior, or model flow were changed.
- Re-ran the requested verification commands after changes; failures remained the same pre-existing `src/workflow/agent-loop.ts` syntax errors.

## Phase 0/1 Consensus Review Closure

### Planner Summary

Principles:

1. Implement only Phase 0 and Phase 1 before any runtime behavior changes.
2. Preserve all existing files and runtime paths.
3. Keep the skeleton minimal and type-only where possible.
4. Treat pre-existing verification failures as baseline evidence, not Phase 0/1 repair scope.
5. Update the plan artifact with completion evidence before stopping.

Decision drivers:

1. User explicitly constrained the implementation to Phase 0 and Phase 1.
2. Phase 1 exit criteria allow typecheck to fail only on known pre-existing errors.
3. Later phases require behavior-moving changes and must not be started in this pass.

Viable options considered:

- Minimal skeleton-first pass: create directories/placeholders, record baseline failures, and stop before behavior changes.
  - Pros: matches Phase 0/1 exactly; preserves runtime behavior; keeps diff small.
  - Cons: leaves existing `src/workflow/agent-loop.ts` syntax errors unresolved.
- Fix baseline TypeScript errors first, then add skeleton.
  - Pros: would make verification green sooner.
  - Cons: violates Phase 0 instruction not to fix current failures and risks runtime behavior changes.

Decision: use the minimal skeleton-first pass.

### Architect Review

APPROVE. The implementation respects the architectural boundary plan without prematurely moving code. The strongest antithesis is that adding placeholder architecture types before repairing the broken current build may create a false sense of progress. The tradeoff is acceptable because Phase 0 explicitly requires recording the current verification state rather than fixing it, and Phase 1 allows compile failure only when it is pre-existing. The next architectural step should repair or intentionally quarantine the broken `src/workflow/agent-loop.ts` syntax before any behavior-moving phase depends on typecheck.

### Critic Verdict

APPROVE. The Phase 0/1 artifact is testable and evidence-backed:

- Branch creation is recorded.
- Baseline and final verification commands were run.
- Final failures match the baseline `src/workflow/agent-loop.ts` syntax errors.
- Runtime behavior was not modified.
- Existing files were not deleted.
- Plan checkboxes and implementation log were updated.

Known risk: the working tree still cannot pass `npm run typecheck`, `npm test`, or `npm run build` until the pre-existing `src/workflow/agent-loop.ts` syntax errors are addressed in a later scoped task.

### ADR: Phase 0/1 Completion

Decision: complete only Phase 0 and Phase 1 with a skeleton-first, no-runtime-change implementation.

Drivers:

- User scope limited this pass to Phase 0 and Phase 1.
- Existing verification failures were explicitly to be recorded, not repaired.
- Future phases need clean architectural boundaries before moving logic.

Alternatives considered:

- Repair pre-existing syntax errors now: rejected because it exceeds Phase 0/1 scope.
- Begin Phase 2 API movement now: rejected because the user explicitly requested Phase 0 and Phase 1 first.

Consequences:

- The target top-level module directories now exist.
- Future phases can add real implementations inside the new boundaries.
- Verification remains blocked by the known pre-existing syntax errors.

Follow-ups:

1. Decide whether the next scoped task should repair `src/workflow/agent-loop.ts` before Phase 2.
2. Begin Phase 2 only after the user explicitly authorizes it.
3. Keep future phase changes small and verify after each boundary move.

## Phase 2 — Move API Layer

### Objective

Replace `src/solar` as the conceptual API boundary with `src/api`.

### Current Source

- `src/solar/client.ts`
- `src/solar/constants.ts`

### Target

```txt
src/api/client.ts
src/api/types.ts
src/api/providers/upstage.ts
src/api/providers/openai-compat.ts
```

### Tasks

- Move Upstage/OpenAI-compatible client creation into `src/api/providers/upstage.ts`.
- Keep default model and base URL constants in a provider-specific place or in `src/api/types.ts` if shared.
- Introduce an `ApiClient` interface that hides the OpenAI SDK from the runtime layer.

Example target shape:

```ts
export type ChatRunOptions = {
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: unknown;
  responseFormat?: unknown;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  model?: string;
};

export interface ApiClient {
  chat(options: ChatRunOptions): Promise<unknown>;
}
```

- Update existing imports from `../solar/client.js` to `../api/client.js` or a provider-specific module.
- Keep behavior equivalent for now.

### Exit Criteria

```bash
npm run typecheck
npm test
```

Result: `npm run typecheck`, `npm test`, and `npm run build` passed after moving callers to `src/api`, adding the Upstage provider implementation, and reducing `src/solar` to compatibility re-exports.

## Phase 3 — Move Runtime Primitives

### Objective

Create a real `runtime` layer that owns low-level execution primitives.

### Move / Split

| Current file | Target |
|---|---|
| `src/tools/filesystem.ts` | `src/runtime/file-ops.ts` |
| `src/tools/process.ts` | `src/runtime/bash.ts` |
| `src/config/*` | `src/runtime/config.ts` or keep `src/config` temporarily with runtime re-export |
| `src/sessions/session-store.ts` | `src/runtime/session.ts` |

### Tasks

- [x] Move file read/write/edit/search implementations into `runtime/file-ops.ts`.
- [x] Move command execution into `runtime/bash.ts`.
- [x] Preserve workspace boundary checks.
- [x] Preserve structured command output:

```txt
exit_code
stdout
stderr
```

- [x] Keep current tests passing by updating imports.
- [x] Do not change behavior yet.

### Exit Criteria

```bash
npm run typecheck
npm test
```

Result: `npm run typecheck` and `npm test` passed after moving file operations to `src/runtime/file-ops.ts`, command execution to `src/runtime/bash.ts`, config ownership to `src/runtime/config.ts`, and session persistence to `src/runtime/session.ts`. Legacy `src/tools`, `src/config`, and `src/sessions` paths remain as compatibility re-exports while callers/tests now use runtime-owned primitives.

## Phase 4 — Introduce ToolSpec And Permission Metadata

Status: completed for metadata/filter/enforcement scope.

### Objective

Replace the current tool registry shape with a `claw-rust`-style `ToolSpec` model.

### Required Types

Create in `src/runtime/permissions.ts`:

```ts
export type PermissionMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
```

Create in `src/tools/specs.ts`:

```ts
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermission: PermissionMode;
};
```

### Required Builtin Tool Specs

Initial builtin tools:

```txt
bash or run_command
read_file
write_file
edit_file
glob_search or list_files
grep_search or search_files
finish
```

For compatibility with current Solarcido, it is acceptable to keep current names:

```txt
list_files
read_file
search_files
write_file
edit_file
run_command
finish
```

But each tool must have `requiredPermission`.

Recommended mapping:

| Tool | Permission |
|---|---|
| `list_files` | `read-only` |
| `read_file` | `read-only` |
| `search_files` | `read-only` |
| `write_file` | `workspace-write` |
| `edit_file` | `workspace-write` |
| `run_command` | `danger-full-access` or command-classified |
| `finish` | `read-only` |

### Rules

- Tool permission must be metadata, not hardcoded only inside switch cases.
- Tool schema generation should derive from `ToolSpec`.
- The model should only receive tools allowed by the current permission mode.
- Execution must also enforce permissions even if the model somehow calls a hidden tool.

### Exit Criteria

- `createToolDefinitions()` can filter by max permission.
- `executeToolCall()` checks permission before execution.
- Existing tool tests still pass.

Result: `npm run typecheck`, `npm test`, `npm run build`, and `node dist/index.js --help` passed after adding `PermissionMode` ordering, deriving model-facing tool schemas from `ToolSpec` metadata, filtering tool definitions by max permission, enforcing tool permissions before dispatch, and adding regression coverage for permission filtering and hidden-tool execution rejection.

## Phase 5 — Implement GlobalToolRegistry

### Objective

Move toward the `claw-rust` `GlobalToolRegistry` model.

### Target

Create `src/tools/registry.ts` with a class like:

```ts
export class GlobalToolRegistry {
  constructor(options?: {
    builtinTools?: BuiltinTool[];
    runtimeTools?: RuntimeToolDefinition[];
    pluginTools?: PluginTool[];
    enforcer?: PermissionEnforcer;
  });

  definitions(options?: {
    allowedTools?: Set<string>;
    maxPermission?: PermissionMode;
  }): OpenAI.Chat.Completions.ChatCompletionTool[];

  permissionSpecs(options?: {
    allowedTools?: Set<string>;
  }): Array<[string, PermissionMode]>;

  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
```

### Tasks

- Move switch-based execution out of `registry.ts` into `executor.ts` or per-tool builtin files.
- Add tool name normalization.
- Support allowed tool filtering.
- Keep plugin/runtime tool support as structural placeholders only.
- Do not implement real plugins yet.

### Exit Criteria

- Tool definitions are generated from registry.
- Tool execution goes through registry.
- Permission enforcement is centralized.
- Tests cover:
  - read-only mode rejects write tools
  - unknown tool returns structured error
  - ambiguous edit still fails
  - command output remains structured

## Phase 6 — Implement PermissionEnforcer

### Objective

Make permission checks explicit and reusable.

### Target

Create:

```txt
src/runtime/permission-enforcer.ts
```

with:

```ts
export type PermissionDecision = {
  approved: boolean;
  reason?: string;
};

export class PermissionEnforcer {
  constructor(policy: PermissionPolicy);

  decideTool(toolPermission: PermissionMode): PermissionDecision;

  decideCommand(command: string): Promise<PermissionDecision>;
}
```

### Tasks

- Move existing approval policy logic into this layer.
- Preserve current `approvalPolicy` behavior:
  - `never`
  - `on-failure`
  - `on-request`
- Preserve sandbox modes:
  - `read-only`
  - `workspace-write`
- Do not implement `danger-full-access` as a user-facing sandbox unless explicitly added later.
- `run_command` may use command classifier internally, but the tool itself should still have permission metadata.

### Exit Criteria

- Tool execution path uses `PermissionEnforcer`.
- Agent code does not manually check sandbox/write permissions.
- Tests cover permission decisions.

## Phase 7 — Build ConversationRuntime

### Objective

Make `runtime/conversation.ts` the real center of agent execution.

### Target

```ts
export class ConversationRuntime {
  constructor(options: {
    apiClient: ApiClient;
    toolRegistry: GlobalToolRegistry;
    sessionStore: SessionStore;
    permissionEnforcer: PermissionEnforcer;
    promptBuilder: SystemPromptBuilder;
  });

  runTurn(input: RunTurnInput): Promise<TurnSummary>;
}
```

### Responsibilities

`ConversationRuntime` should own:

1. session creation / loading
2. system prompt assembly
3. message list construction
4. model invocation
5. tool call execution
6. tool result append
7. finish detection
8. error handling
9. compaction trigger
10. final turn summary

### Rules

- Do not duplicate agent loops in each agent file.
- Do not keep `while (true)` without max turn or abort control.
- Add a max turn guard.
- Tool execution errors should be returned to the model as structured tool output when recoverable.
- Command failures should not crash the workflow by default.
- Runtime should not know CLI formatting details.

### Exit Criteria

- CLI can execute a one-shot coding task through `ConversationRuntime`.
- `npm run typecheck`
- `npm test`
- `npm run build`

## Phase 8 — Thin CLI Layer

### Objective

Make CLI a thin input/output layer.

### Target

Move current `src/cli.ts` into:

```txt
src/cli/parse-args.ts
src/cli/main.ts
src/cli/repl.ts
```

### Tasks

- `parse-args.ts` should only parse command-line arguments.
- `main.ts` should dispatch to runtime or command dispatcher.
- `repl.ts` should run interactive input loop.
- CLI should not own tool execution, prompt construction, or session persistence.

### Exit Criteria

Current commands still work:

```bash
solarcido
solarcido run "..."
solarcido config get
solarcido config set <key> <value>
solarcido config path
solarcido sessions list
solarcido sessions show <id>
```

## Phase 9 — Command Registry

### Objective

Move slash command definitions out of help text and into a registry.

### Target

Create `src/commands/specs.ts`:

```ts
export type SlashCommandSpec = {
  name: string;
  aliases: string[];
  summary: string;
  argumentHint?: string;
  resumeSupported: boolean;
};
```

Initial commands:

```txt
help
status
model
reasoning
approval
sandbox
cwd
clear
quiet
verbose
exit
quit
config
sessions
```

Optional near-term additions:

```txt
diff
doctor
compact
cost
```

### Rules

- Help text should be generated from command specs.
- Interactive command handling should dispatch through `commands/dispatcher.ts`.
- Do not add MCP/plugin/worker/task commands yet.

### Exit Criteria

- `/help` output comes from command registry.
- CLI help and interactive help do not drift.
- Tests cover command registry basics.

## Phase 10 — Remove Transitional Workflow/Agents Code

### Objective

Remove or quarantine the current transitional architecture.

### Remove or Refactor

Candidates:

```txt
src/workflow/orchestrator.ts
src/agents/planner.ts
src/agents/explorer.ts
src/agents/executor.ts
src/agents/reviewer.ts
src/workflow/run-agent-loop.ts
```

### Rules

- Do not keep broken imports.
- Do not keep planner/explorer/executor/verifier/reviewer as the core architecture.
- If orchestration remains, place it behind runtime as an experimental layer:

```txt
src/runtime/orchestration/
```

or

```txt
src/experimental/orchestration/
```

- Default path should be `ConversationRuntime`, not the current orchestrator.

### Exit Criteria

- No dead code.
- No unused imports.
- No duplicate agent loop implementations.
- One-shot run path is clear and documented.

## Phase 11 — Documentation Update

### Objective

Update documentation so the repository clearly states that Solarcido is a TypeScript / Upstage port of the `claw-rust` reference architecture.

### Update

- `README.md`
- `docs/SPEC.md`
- `docs/ROADMAP.md`

### Required Documentation Points

README should explain:

- Solarcido is built around an API/runtime/tools/commands architecture.
- Upstage Solar is the primary provider.
- The current implementation is a TypeScript port of the local `claw-rust` reference structure.
- Which features are currently implemented.
- Which features are planned later.

SPEC should define:

- `api` responsibilities
- `runtime` responsibilities
- `tools` responsibilities
- `commands` responsibilities
- permission model
- session model
- tool contract
- runtime loop contract

ROADMAP should reflect:

- current restructuring phase
- later MCP/plugin/task/worker phases

### Exit Criteria

- Docs match code.
- No claim of implemented MCP/plugin/worker/task support unless actually implemented.

## Verification Commands

Run after each meaningful phase:

```bash
npm run typecheck
npm test
npm run build
node dist/index.js --help
```

If Windows-specific validation is needed:

```cmd
npm run typecheck
npm test
npm run build
node dist\index.js --help
```

## Acceptance Criteria For This Refactor

The refactor is complete when:

1. `src` has the target high-level module boundaries:
   - `api`
   - `runtime`
   - `tools`
   - `commands`
   - `plugins`
   - `telemetry`
   - `cli`

2. The default one-shot run path is:

```txt
cli -> runtime ConversationRuntime -> api client -> tool registry -> runtime primitives
```

3. Tool definitions are generated from `ToolSpec`.

4. Every tool has a `requiredPermission`.

5. Tool visibility and tool execution both enforce permission mode.

6. `ConversationRuntime` owns the model/tool loop.

7. CLI no longer owns execution internals.

8. The old planner/explorer/executor/verifier/reviewer orchestration is removed or explicitly marked experimental.

9. Tests cover:
   - CLI parsing
   - config validation
   - filesystem boundary checks
   - edit ambiguity
   - command structured output
   - tool permission enforcement
   - read-only rejection of write tools
   - runtime finish handling

10. These commands pass:

```bash
npm run typecheck
npm test
npm run build
node dist/index.js --help
```

## Important Implementation Notes

- Do not delete useful code immediately. Move and adapt it.
- Do not preserve file names just because they exist.
- Prefer new architecture boundaries over backward compatibility with current internals.
- Keep public CLI behavior stable unless the change is intentional and documented.
- Do not introduce MCP, plugins, workers, or task background execution until the core runtime is stable.
- Avoid a big-bang rewrite in one commit. Make one architectural boundary change at a time.
- If a phase fails, stop and fix that phase before proceeding.
