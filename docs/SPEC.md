# Solarcido Tight Spec

This spec defines the target shape for Solarcido as a small, local terminal coding agent built on Upstage Solar. It borrows architectural ideas from Codex CLI, but the implementation must stay idiomatic to this TypeScript repository.

For implementation order, use `docs/ROADMAP.md`.

## Product Contract

Solarcido is a local coding agent that:

- Runs from a terminal in either interactive or one-shot mode.
- Uses the selected working directory as the boundary for repository tools.
- Lets the model inspect files, search code, edit files, run commands, and finish with a structured summary.
- Keeps user-visible behavior predictable through explicit CLI flags, config defaults, tool contracts, and verification commands.

Solarcido is not:

- A clone of Codex internals.
- A Rust/Bazel/TUI workspace.
- A general shell automation tool outside the selected repository.
- A cloud agent or hosted service.

## Architecture

Core modules:

- `src/index.ts`: process entrypoint, dotenv loading, top-level error handling.
- `src/cli.ts`: command-line parsing and help text.
- `src/interactive.ts`: terminal session loop and slash commands.
- `src/workflow/run-agent-loop.ts`: one-shot workflow wrapper over the runtime.
- `src/runtime/conversation.ts`: direct model/tool loop, session lifecycle, prompt/message assembly, finish detection, and runtime error handling.
- `src/runtime/prompt.ts`: system prompt construction for runtime turns.
- `src/workflow/orchestrator.ts`: target multi-agent workflow coordinator.
- `src/agents/`: target role-specific agent loops for planning, exploration, execution, verification, and review.
- `src/tools/registry.ts`: tool schema definitions, argument validation, and dispatch.
- `src/tools/filesystem.ts`: workspace-scoped file operations.
- `src/tools/process.ts`: workspace-scoped command execution.
- `src/api/client.ts`: provider-neutral API client entrypoint.
- `src/api/providers/upstage.ts`: OpenAI-compatible Upstage client and provider defaults.

Boundary rules:

- CLI parsing must not call model APIs or tools.
- The workflow loop must not implement file or process behavior directly.
- Tool schemas and argument validation belong in `registry.ts`; side effects belong in dedicated tool modules.
- File and process tools must never operate outside the resolved `cwd`.
- New large features should get a new module instead of expanding central orchestration files.
- Multi-agent orchestration must pass structured summaries between agents, not raw full transcripts.

## Command Surface

Required commands:

```txt
solarcido
solarcido run "<goal>"
solarcido run "<goal>" --resume <id>
solarcido init [--cwd .]
solarcido team <tasks.json> [--concurrency N]
solarcido orchestrate "<goal>"
solarcido cron <cron.json>
solarcido --help
```

`solarcido cron` is an in-process daemon that fires scheduled goals (owner:
`src/workflow/cron-daemon.ts` + `src/runtime/cron/*`; input: a JSON array or
`{jobs:[…]}` of `{name,schedule,goal}` with 5-field UTC cron schedules; it loops
until killed, running due goals through the agent loop; verification:
`tests/cron-daemon.test.mjs`).

`solarcido orchestrate` runs the multi-agent pipeline (owner:
`src/workflow/orchestrator.ts` `orchestrateGoal`; planner → explorer → executor
→ verifier → reviewer over the Solar client; output: a per-agent summary;
verification: `tests/orchestrator.test.mjs`).

`solarcido team` runs a batch of goals from a tasks file through the agent loop
(owner: `src/workflow/team.ts`; input: a JSON array or `{tasks:[…]}` of strings
or `{prompt,description}`, plus `--concurrency` and the usual run flags; output:
a per-task completed/failed report; verification: `tests/team.test.mjs`). Tasks
run via the TaskRunner over a TaskRegistry; cron scheduling is out of scope.

`--resume <id>` continues a saved session by seeding its persisted message transcript (owner: `src/runtime/session.ts` `loadSessionForResume` + `ConversationRuntime.runTurn` `resumeMessages`; verification: `tests/resume.test.mjs`). Sessions persist their transcript only on completion.

`solarcido init` scaffolds project guidance (owner: `src/cli/init.ts`; input: optional `--cwd`; output: an idempotent `InitReport` of CLAUDE.md + .gitignore artifacts tagged created/updated/skipped; verification: `tests/init.test.mjs`).

Required flags:

```txt
--cwd <path>           working directory, default process.cwd()
--reasoning <level>    low | medium | high
--model <name>         model override
--quiet                suppress assistant chat messages
```

Future command targets:

```txt
solarcido config get [key]
solarcido config set <key> <value>
solarcido exec "<goal>"      alias for run, if needed for Codex-like naming
```

Do not add a new command unless it has a documented owner module, input shape, output shape, and verification command.

## Interactive Shell

Required slash commands:

```txt
/help
/model [name]
/reasoning [low|medium|high]
/cwd
/status
/clear
/quiet
/verbose
/exit
/quit
/version
/diff
/init
```

`/init` runs the same scaffolding as `solarcido init` for the session cwd (owner: `src/cli/init.ts`, verification: `tests/init.test.mjs`).

`/version` prints the CLI version + build info (owner: `src/commands/introspection.ts`, output: version/commit/node/platform lines, verification: `tests/commands-introspection.test.mjs`). `/diff` prints the working-tree `git diff` for the session cwd, degrading to a clean message outside a git repo (owner: `src/commands/introspection.ts`, verification: `tests/commands-introspection.test.mjs`).

Interactive constraints:

- Slash command help must match implemented commands.
- Session-local changes must not mutate persistent config unless the command explicitly says so.
- Input handling must preserve paste support.
- UI changes must not obscure model/tool output.

## Configuration

Solarcido uses environment variables, CLI flags, and a persistent config file:

```txt
~/.solarcido/config.json
```

Config shape:

```json
{
  "model": "solar-pro3-260323",
  "reasoningEffort": "high",
  "approvalPolicy": "on-failure",
  "sandbox": "workspace-write",
  "quiet": false
}
```

Precedence, highest first:

1. CLI flags.
2. Interactive session overrides.
3. `~/.solarcido/config.json`.
4. Built-in defaults from `src/api/client.ts`.

Config rules:

- Config validation must produce user-readable errors.
- Config docs and examples must be updated with any config schema change.
- Do not silently ignore unknown config keys.

## Approval And Sandbox Policy

Target policies:

```txt
approvalPolicy:
  never        run allowed commands without asking
  on-failure   ask before retrying a failed command with elevated capability
  on-request   ask before any command marked risky

sandbox:
  read-only        no file writes
  workspace-write  writes only under cwd
  danger-full-access reserved; do not implement until there is an explicit security review
```

Current implementation status:

- File tools are workspace-scoped.
- Command execution runs inside `cwd`.
- `on-request` prompts before risky commands when a TTY is available and denies those commands in non-interactive contexts.
- `read-only` disables file write/edit tools.
- There is no OS-level process sandbox yet.

Implementation rule:

- Do not claim full OS-level sandboxing until process isolation is actually implemented.

## Tool Contract

Every model tool must have:

- A JSON schema in `src/tools/registry.ts`.
- Runtime argument validation.
- A workspace boundary check before filesystem/process side effects.
- Concise output intended for the model, not a human UI.
- Recoverable `ERROR:` output for user/model mistakes where the loop can continue.

Current core tools:

```txt
list_files
read_file
search_files
write_file
edit_file
run_command
finish
```

Tool behavior requirements:

- `list_files` skips high-noise folders by default.
- `read_file` supports line-window reads for large or focused inspection.
- `search_files` returns `path:line: content` matches.
- `edit_file` uses exact string replacement and rejects ambiguous replacements unless `replace_all` is explicit.
- `write_file` is for new files or intentional full-file replacement.
- `run_command` returns `exit_code`, `stdout`, and `stderr`.
- `finish` returns summary, changed files, and next steps.

## Agent Loop

The current workflow loop must:

- Send a concise system prompt describing Solarcido's role and available tool strategy.
- Preserve the full tool output in model-visible messages.
- Keep CLI formatting outside the runtime loop; one-shot CLI output prints the final structured finish summary.
- Stop only when `finish` is called, the user interrupts the process, or an external runtime/API limit is reached.
- Treat tool execution errors as model-visible results when recovery is possible.

The model should be instructed to:

- Search before broad file reads.
- Prefer focused edits over full rewrites.
- Run relevant verification after changes.
- Stay inside `cwd`.

## Multi-Agent Orchestration

Multi-agent orchestration is the target workflow for larger coding tasks. Its
design is defined in `docs/MULTI_AGENT_ORCHESTRATION.md`.

The orchestrated workflow must:

- Keep `runWorkflow` as the CLI-facing entrypoint.
- Split work into short-lived role-specific agents.
- Use a planner, read-only explorer, executor, verifier, and reviewer sequence before adding parallelism.
- Keep file writes centralized in the executor for the first implementation.
- Pass only compact structured results between agents.
- Avoid storing full agent transcripts in session metadata.
- Track an estimated per-agent context budget.
- Compact an agent's local messages before the next model request when the estimated context reaches 90% of the configured context window.

The orchestrator should store only durable workflow state:

- User goal.
- Plan summary.
- Agent result summaries.
- Changed files.
- Verification status.
- Final summary, risks, and next steps.

The orchestrator must not:

- Perform file or process side effects directly.
- Merge raw tool outputs from agents into its own context.
- Run parallel mutating agents until conflict handling is explicitly designed.

## MCP Roadmap

MCP support is a future extension, not current behavior.

Target shape:

- Add a dedicated `src/mcp/` module.
- Keep MCP server config under the future config file.
- Keep mutation of MCP tools and tool calls centralized in one manager module.
- Do not thread MCP-specific mutation logic through unrelated workflow layers.
- Require explicit approval mode per MCP server before enabling mutating tools.

## Logging And Diagnostics

Target environment variables:

```txt
SOLARCIDO_LOG=debug|info|warn|error
SOLARCIDO_HOME=<path>
```

Rules:

- Logs must not include API keys or secrets.
- Verbose logs should be opt-in.
- User-facing errors should include the failing subsystem and a concrete next step.

## Sessions

Solarcido writes compact session metadata under:

```txt
~/.solarcido/sessions/
```

Rules:

- Store session id, timestamps, status, goal, cwd, selected model/settings, summary, changed files, next steps, and failure message.
- Do not store API keys or environment secrets.
- Do not store unbounded full tool output in session metadata.
- Use `solarcido sessions list` and `solarcido sessions show <id>` for inspection.

## Verification Gates

After TypeScript changes:

```bash
npm run typecheck
```

After runtime or CLI behavior changes:

```bash
npm run build
node dist/index.js --help
```

Before changing release/install behavior:

```bash
npm run build
```

Do not update `dist/` by hand.

## Documentation Gates

Update `README.md` when changing:

- CLI commands or flags.
- Environment variables.
- Tool capabilities visible to users.
- Install or build instructions.

Update this spec when changing:

- Module ownership.
- Tool contracts.
- Config schema.
- Approval or sandbox semantics.
- MCP behavior.

## Implementation Priorities

1. Stabilize tool contracts and error handling.
2. Add config loading with validation.
3. Add approval policy plumbing for commands.
4. Add tests for CLI parsing and tool path boundaries.
5. Add multi-agent orchestration for context isolation.
6. Add MCP only after config, approval policies, and orchestration boundaries are stable.
