# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Solarcido is a terminal coding assistant (like Codex CLI) built on the Upstage Solar API. You describe a task; it inspects the repo, edits files, searches code, runs commands, and verifies — all constrained to a chosen working directory.

The **live product is the TypeScript CLI in `src/`** (compiled to `dist/`). Two other trees exist for parity/reference only and are **not** what ships:
- `crates/` — a Rust port (Cargo workspace) kept for comparison/parity work.
- `claw-rust/` — a frozen reference snapshot, explicitly `exclude`d from the Cargo workspace.

Unless a task is explicitly about Rust parity, work in `src/`.

## Commands

```bash
npm install
npm run dev          # run from source via tsx (no build) — fastest dev loop
npm run typecheck    # tsc --noEmit; run after any TS change
npm run build        # tsc -> dist/ (required before `npm start`, the bin, or tests)
npm start            # node dist/index.js
npm test             # builds, then runs an explicit list of tests/*.test.mjs against dist/
```

There is **no TypeScript linter** — `npm run typecheck` (`tsc --noEmit`) is the only static gate. (`cargo clippy` lints the Rust port only.)

Tests are `node:test` files in `tests/` that **import from `dist/`, not `src/`** — so they require a build first. `npm test` runs a **hard-coded, ordered list** of files (`cli`, `config`, `approvals`, `sessions`, `tools`, `execution-guard`, `conversation`), *not* a glob — so **a new `tests/*.test.mjs` file is silently skipped until you add it to the `test` script in `package.json`**. To run a single file or filter by name, build first, then:

```bash
npm run build
node tests/tools.test.mjs                                  # one file
node --test --test-name-pattern="line windows" tests/tools.test.mjs   # one test
```

Rust port (only for parity work):

```bash
npm run build:rust                                  # = cargo build -p solarcido-cli
cargo run -p solarcido-cli -- prompt "..." --cwd .
```

`UPSTAGE_API_KEY` is required for any real model call (`.env` is loaded). Tests do not hit the API.

## Architecture (the live TypeScript path)

Entry and dispatch:
- `bin/solarcido.js` — thin launcher that **requires a prior `npm run build`** (it execs `dist/index.js`).
- `src/index.ts` → `src/cli/main.ts` — parses argv (`src/cli/parse-args.ts`) into one of: `help | interactive | run | config | sessions`, merging with persistent config.
- `run` and `interactive` both funnel into `runWorkflow` (`src/workflow/run-agent-loop.ts`).

The actual agent loop is **`ConversationRuntime.runTurn` in `src/runtime/conversation.ts`** — this is the heart of the system. Per turn it: builds a system prompt (`src/runtime/prompt.ts`) + the goal, calls Solar, appends the assistant message, executes each tool call via the registry, and compacts the transcript when it exceeds the token budget. It ends when the model calls the `finish` tool (capped at `DEFAULT_MAX_TURNS = 20`).

**Execution guard** (`src/agents/execution-guard.ts`) is a key cross-cutting rule: if the goal looks like it requires changes (keyword heuristic, including Korean keywords), a `finish` call is *rejected* with an error until an `edit_file`/`write_file` has actually succeeded. This stops the model from "finishing" with only a plan. Keep this behavior in mind when changing the loop.

Tools:
- Tool JSON schemas + dispatch logic live in `src/tools/executor.ts` (`BUILTIN_TOOL_SPECS`, `executeBuiltinTool`); shared TypeScript types (`ToolSpec`, `ToolExecutionResult`, `ToolExecutionContext`, `FinishPayload`) live in `src/tools/specs.ts`. Tools: `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `run_command`, `finish`.
- `src/tools/registry.ts` (`GlobalToolRegistry`) registers tools, filters them by permission, and dispatches by name. It **normalizes/aliases** tool names (`bash`→`run_command`, `glob_search`→`list_files`, `grep_search`→`search_files`, hyphens→underscores) so the model can use familiar names.
- Implementations: `src/runtime/file-ops.ts` (list/read/search/write/edit) and `src/runtime/bash.ts` (commands). File ops are all sandboxed to the working dir via `resolveInsideRoot` (path.resolve + path.relative check) — paths that escape throw.

Permissions & approvals:
- `src/runtime/permissions.ts` — ranks `read-only < workspace-write < danger-full-access`.
- `src/runtime/permission-enforcer.ts` — gates tools by sandbox mode and gates *risky* commands (regex list: `rm`, `git push/reset/checkout`, `npm install/publish`, `curl`, `sudo`, …) by approval policy. The CLI prompt for approval is `src/approvals/prompt.ts`.

Config & sessions:
- `src/runtime/config.ts` — persistent config at `~/.solarcido/config.json` (or `$SOLARCIDO_HOME/config.json`). Keys: `model`, `reasoningEffort`, `approvalPolicy`, `sandbox`, `quiet`. CLI flags override config. Adding a key means updating `CONFIG_KEYS`, `parseConfigValue`, and `validateConfigField` together.
- `src/runtime/session.ts` — runs are persisted under `SOLARCIDO_HOME`; `sessions list`/`show` read them.

API layer:
- `src/api/providers/upstage.ts` — wraps the `openai` SDK pointed at `https://api.upstage.ai/v1`. Default model `solar-pro3-260323`, default reasoning effort `high`. `src/api/client.ts` re-exports it behind `createApiClient`.

Interactive shell:
- `src/cli/repl.ts` — a custom raw-mode line reader with bracketed-paste handling and a live `/` slash-command picker. Slash commands are declared in `src/commands/specs.ts`, parsed/matched in `src/commands/registry.ts`, and handled in `src/commands/dispatcher.ts`.

## Things that will trip you up

- **AGENTS.md is partly stale on paths.** It predates a refactor (branch `refactor/claw-rust-ts-structure`). Its *rules* still apply, but where it says `src/solar/` read `src/api/`, and the agent loop is now `ConversationRuntime` in `src/runtime/conversation.ts`, not a flat `run-agent-loop.ts` implementation. Trust the actual tree over AGENTS.md's file list.
- **Compatibility shims exist.** `src/cli.ts`, `src/interactive.ts`, `src/solar/*`, `src/sessions/*`, `src/approvals/classify-command.ts`, and `src/tools/{filesystem,process}.ts` are 1–6 line re-exports pointing at the canonical modules (`src/cli/`, `src/api/`, `src/runtime/`). Edit the canonical module, not the shim. (`src/tools/filesystem.ts` → `src/runtime/file-ops.ts`; `src/tools/process.ts` → `src/runtime/bash.ts`.)
- **The multi-agent orchestration is dormant.** `src/workflow/orchestrator.ts` (`orchestrateGoal`) plus `src/agents/{planner,explorer,executor,verifier,reviewer}.ts` and the generic `src/workflow/agent-loop.ts` implement a planner→executor→reviewer pipeline, but `orchestrateGoal` is **not called anywhere** — the CLI always uses the single `ConversationRuntime` loop. Don't assume these agents run in the normal flow.
- **`dist/` is generated** and git-ignored; never edit it. Change `src/` and rebuild.

## Conventions

`AGENTS.md` holds the authoritative TypeScript style and tooling rules; `docs/SPEC.md` is the product/architecture contract and `docs/ROADMAP.md` the implementation order. Check `docs/SPEC.md` before adding commands, tools, config keys, or changing approval/sandbox behavior. Highlights worth repeating:

- When adding a tool: add its spec/schema in `src/tools/executor.ts`, validate args before the implementation, keep the implementation in an appropriate `src/runtime/*` module, return concise model-readable output, and surface recoverable failures as `ERROR: ...` tool results rather than throwing (the loop continues on tool errors).
- Keep `src/cli/main.ts` help text + `README.md` in sync when changing CLI flags/commands, and `src/commands/specs.ts` in sync with implemented slash commands.
- Run `npm run typecheck` after TS changes; run `npm test` when touching CLI parsing, config, tools, permissions, or command behavior.
