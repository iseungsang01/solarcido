# Solarcido Rust Port Spec And Roadmap

This document defines how to port the local `claw-rust/` reference into
Solarcido's Rust workspace under `crates/`.

The guiding rule is intentionally narrow:

- Keep Solarcido-specific model/API behavior.
- Accept the existing `claw-rust/` architecture, CLI behavior, tools, runtime
  semantics, config surfaces, tests, and harnesses as much as practical.
- Rename and adapt only where Solarcido's product identity, provider contract,
  repository layout, or safety requirements require it.

The current TypeScript implementation remains the working product until the
Rust workspace reaches the migration gate in this document.

## Source Of Truth

Use these files in this order when making porting decisions:

1. `docs/RUST_PORT.md` for the Rust port contract.
2. `claw-rust/README.md`, `claw-rust/PARITY.md`, and `claw-rust/USAGE.md` for
   the reference Rust behavior.
3. `claw-rust/crates/*` for implementation details.
4. `docs/SPEC.md` and `docs/ROADMAP.md` for Solarcido's existing TypeScript
   product commitments.

When `claw-rust/` and the TypeScript spec disagree, prefer `claw-rust/` unless
the disagreement is one of these Solarcido boundaries:

- Provider/API identity.
- Environment variable names and default model.
- Binary name and user-facing Solarcido branding.
- On-disk state namespacing, if explicitly decided below.
- Security behavior that would make Solarcido less safe than its documented
  current behavior without an explicit migration decision.

Confirmed decisions:

- State paths are renamed to Solarcido paths. Solarcido writes
  `.solarcido`/`.solarcido.json` and `~/.solarcido`, not `.claw`.
- Default permission mode is `danger-full-access`, matching `claw-rust`.
- Config, web tools, and agent/team/cron behavior should follow `claw-rust`
  where a reference implementation exists.
- If `claw-rust` does not define the needed behavior, choose the smallest
  Solarcido-native behavior that keeps the port moving and document it in the
  parity file.
- Solarcido accepts exact Solar model names only. Do not add model aliases.
- After the Rust migration gate, remove or explicitly retire the TypeScript CLI
  in a separate cleanup rather than keeping two long-term implementations.
- Plugin and skill schemas should be renamed to Solarcido schemas, not merely
  rebranded in display text.

## Non-Goals

- Do not keep expanding the TypeScript implementation while the Rust port is the
  active track, except for urgent fixes.
- Do not copy `claw-rust/` as a nested compiled workspace.
- Do not retain Anthropic-only public names in Solarcido user-facing behavior.
- Do not hand-edit generated build artifacts.
- Do not claim feature parity until the parity harness and manual gates pass.

## Provider Contract

Solarcido keeps Upstage Solar as the model provider.

Required behavior:

- Default model: `solar-pro3-260323`.
- API key env: `UPSTAGE_API_KEY`.
- Base URL env: `UPSTAGE_BASE_URL`.
- Default base URL: `https://api.upstage.ai/v1`.
- Request style: OpenAI-compatible chat completions unless Solar requires a
  later endpoint change.
- Keep `reasoning_effort` as `low | medium | high` when the selected Solar
  model accepts it.
- Normalize provider errors into runtime-readable errors that include status,
  provider message, and body when available.
- Never log API keys, auth tokens, or full secret-bearing environment values.

What to port from `claw-rust/crates/api`:

- Streaming response handling.
- Request and response type separation.
- Usage/token accounting surfaces.
- Context/request preflight checks where they are provider-neutral.
- Mock provider harness shape, adapted to a Solar/OpenAI-compatible mock.

What to replace:

- Anthropic endpoint paths and message wire format.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`.
- Claude model aliases such as `opus`, `sonnet`, and `haiku`.

Model aliases for Solarcido should be explicit and Solar-specific. Until a
separate alias table is approved, do not add aliases beyond the literal model
name. The current approved behavior is exact Solar model names only.

## Target Workspace Layout

The current Rust workspace has a small four-crate shape:

```text
crates/
  api/
  runtime/
  tools/
  solarcido-cli/
```

The target port should move closer to the reference `claw-rust/` layout:

```text
crates/
  api/                  Solar/OpenAI-compatible provider client and streaming
  commands/             Slash command registry, parsing, help, JSON/text output
  compat-harness/       Manifest/parity extraction and scenario helpers
  mock-solar-service/   Deterministic Solar/OpenAI-compatible mock service
  plugins/              Plugin metadata, lifecycle, hook integration surfaces
  runtime/              Conversation runtime, config, sessions, MCP, permissions
  solarcido-cli/        Main binary, REPL, direct commands, display rendering
  telemetry/            Usage, cost, tracing, and session telemetry payloads
  tools/                Built-in tools, tool discovery, skills, agents, web tools
```

Porting rule:

- Prefer preserving crate/module names from `claw-rust/` when the name is
  generic, such as `runtime`, `commands`, `tools`, `plugins`, and `telemetry`.
- Rename only brand-specific crates and binaries, such as
  `rusty-claude-cli` to `solarcido-cli`.
- Keep `claw-rust/` as a local reference snapshot and do not include it in the
  root Cargo workspace.

## CLI Contract

Target top-level command shape follows `claw-rust`:

```text
solarcido [OPTIONS] [COMMAND]
```

Required options:

```text
--model MODEL
--output-format text|json
--permission-mode read-only|workspace-write|danger-full-access
--dangerously-skip-permissions
--allowedTools TOOLS
--resume [SESSION.jsonl|session-id|latest]
--cwd PATH
--reasoning-effort low|medium|high
--version, -V
--help, -h
```

Required commands:

```text
prompt <text>
run <text>              Compatibility alias for prompt
status
sandbox
agents
mcp
skills
system-prompt
init
help
version
```

Porting rules:

- Keep `prompt` as the canonical claw-like one-shot command.
- Keep `run` as a Solarcido compatibility alias for the old TypeScript CLI.
- Keep JSON output surfaces for automation wherever `claw-rust` has them.
- Prefer `claw-rust` help text structure, replacing provider and brand names.
- Keep unknown option errors strict.

## REPL And Slash Commands

Move slash command handling out of the CLI file and into `crates/commands`,
matching `claw-rust`.

Initial required slash commands:

```text
/help
/status
/sandbox
/compact
/model [model]
/permissions [read-only|workspace-write|danger-full-access]
/clear
/cost
/resume <session-path|session-id|latest>
/config [env|hooks|model|plugins]
/mcp [list|show <server>|help]
/memory
/init
/diff
/version
/session [list|switch <session-id>|fork [branch-name]|delete <session-id>]
/plugin [list|install <path>|enable <name>|disable <name>|uninstall <id>|update <id>]
/agents [list|help]
/skills [list|install <path>|help|<skill> [args]]
/doctor
/hooks [list|run <hook>]
/exit
/quit
```

Porting rules:

- First port the registry, parser, aliases, and help rendering.
- Stub commands are acceptable only when they return explicit
  `not yet implemented` output and are tracked in the parity matrix.
- Do not bury slash command behavior in `solarcido-cli`; command definitions
  belong in `crates/commands`.
- Tab completion, recent session IDs, and richer REPL editing should follow
  after the registry and session system are stable.

## Runtime Contract

The Rust runtime should converge on `claw-rust/crates/runtime`.

Required runtime capabilities:

- Multi-turn session state.
- Streaming assistant output.
- Tool-call loop with multiple tool calls per assistant turn.
- Structured tool results fed back to the model.
- Permission enforcement across all tools.
- Session persistence and resume.
- Config loading and merge precedence.
- MCP server lifecycle and tool bridge.
- Plugin and hook integration points.
- Usage and cost accounting.
- System prompt assembly from provider, tools, memory, config, and runtime
  state.

Solarcido-specific changes:

- System prompts should identify the assistant as Solarcido.
- Provider sections should describe Upstage Solar instead of Anthropic/Claude.
- Memory files should prefer Solarcido names unless the compatibility decision
  below chooses to keep claw names.

## Tool Contract

Port the `claw-rust` tool surface as the target tool surface.

Core tools that must become real implementations before migration:

```text
bash
read_file
write_file
edit_file
glob_search
grep_search
WebFetch
WebSearch
TodoWrite
NotebookEdit
ToolSearch
Sleep
SendUserMessage
StructuredOutput
Config
```

Agent and orchestration tools:

```text
Agent
TaskCreate
TaskGet
TaskList
TaskStop
TaskUpdate
TaskOutput
TeamCreate
TeamDelete
CronCreate
CronDelete
CronList
```

MCP and integration tools:

```text
ListMcpResources
ReadMcpResource
MCP
McpAuth
LSP
REPL
PowerShell
```

Porting rules:

- Preserve `claw-rust` schemas and result shapes unless a Solar provider
  constraint requires a change.
- Keep tool execution bounded by the selected working directory unless the
  selected permission mode explicitly allows broader access.
- Preserve file edge-case behavior: path traversal prevention, symlink escape
  checks, binary detection, size limits, and ambiguous edit rejection.
- Preserve bash validation modules: path validation, read-only validation,
  destructive command warnings, command semantics, permission checks, and
  sandbox decision logic.
- Tool failures caused by user/model input should return model-readable
  `ERROR:` output when the loop can continue.

## Permission And Sandbox Contract

Target default follows `claw-rust`:

```text
default permission mode: danger-full-access
```

Supported modes:

```text
read-only
workspace-write
danger-full-access
```

Required behavior:

- `read-only` allows inspection tools and blocks writes/commands that mutate.
- `workspace-write` allows writes under the selected workspace and asks for
  higher-risk actions based on the claw permission system.
- `danger-full-access` follows the claw behavior and should be visibly labeled
  as dangerous.
- `--dangerously-skip-permissions` maps to `danger-full-access`.
- Permission prompts must support approval and denial in the REPL and one-shot
  prompt paths.
- Non-interactive denial behavior must be deterministic and JSON-readable when
  `--output-format json` is active.

If the implementation does not provide OS-level sandboxing on a platform, the
status output must say so directly.

## Config And State Contract

Reference `claw-rust` has `.claw` and `.claw.json` surfaces. Solarcido needs a
renamed namespace for new state.

Preferred Solarcido namespacing:

```text
~/.solarcido/
~/.solarcido/config.json
~/.solarcido/sessions/
<repo>/.solarcido/
<repo>/.solarcido.json
```

Compatibility namespacing, if selected:

```text
~/.claw/
.claw/
.claw.json
```

Confirmed state behavior:

- Use Solarcido namespacing for new state.
- Port the `claw-rust` config semantics, but rename files and user-facing schema
  names to Solarcido.
- Do not write `.claw` files from Solarcido.
- Do not auto-read `.claw.json` as active config. A future import command may
  read `.claw.json` once and write the converted result to `.solarcido.json`.

Target config precedence:

1. CLI flags.
2. REPL session overrides.
3. Repository local config.
4. User config.
5. Built-in defaults.

Config must reject unknown keys unless the `claw-rust` loader intentionally
preserves plugin-specific extension fields.

## MCP, Plugins, Hooks, Skills

These should be ported after the core runtime, tools, and sessions are stable.

Required direction:

- Port `crates/plugins` rather than inventing a new plugin format.
- Rename user-facing text from Claw/Claude to Solarcido/Solar.
- Rename plugin and skill schema fields to Solarcido-owned names instead of
  keeping Claw schema names as the public contract.
- Keep plugin install/enable/disable/uninstall/update command shapes.
- Keep lifecycle hooks config-backed and auditable.
- Keep MCP server config centralized in runtime/config modules.
- Mutating MCP tools require explicit permission behavior.
- Skills should use the same discovery/install/invoke flow as `claw-rust`,
  with Solarcido-branded help text.

## Parity Harness

Solarcido should inherit the mock parity discipline from `claw-rust`.

Create:

```text
crates/mock-solar-service/
crates/solarcido-cli/tests/mock_parity_harness.rs
scripts/run_mock_parity_harness.sh
scripts/run_mock_parity_diff.py
mock_parity_scenarios.json
docs/RUST_PARITY.md
```

Required initial scenarios:

```text
streaming_text
read_file_roundtrip
grep_chunk_assembly
write_file_allowed
write_file_denied
multi_tool_turn_roundtrip
bash_stdout_roundtrip
bash_permission_prompt_approved
bash_permission_prompt_denied
plugin_tool_roundtrip
session_resume_roundtrip
mcp_tool_roundtrip
```

The mock service should mimic Solar's OpenAI-compatible chat completion shape,
including tool calls, streaming chunks, provider errors, and usage payloads.

## Porting Method

Use a mechanical-first porting style:

1. Copy the relevant `claw-rust` crate/module into the matching Solarcido crate
   or new crate.
2. Rename package, binary, module paths, and user-facing strings.
3. Replace provider-specific API code with Solar-compatible code.
4. Keep tests as close as possible to the reference tests.
5. Make the smallest compile fixes needed.
6. Add Solar-specific tests only for changed behavior.
7. Update the parity matrix immediately when behavior is stubbed or deferred.

Avoid rewriting working `claw-rust` logic into a different local style unless
there is a concrete Solarcido reason.

## Current Progress

Current workspace:

- `crates/api` has a Solar chat completion client with SSE streaming, an
  incremental SSE frame parser (`sse.rs`), streaming chunk types, and a
  `SolarStream` that yields high-level `StreamEvent` values.
- `crates/runtime` has an in-memory conversation loop with permission policy
  and both non-streaming (`run_turn`) and streaming (`run_turn_streaming`)
  turn execution paths.
- `crates/tools` has basic workspace tools.
- `crates/solarcido-cli` has a CLI and REPL with real-time streaming output.

Current gap:

- The existing Rust crates are a prototype, not a full claw-style port.
- The next work should import the broader `claw-rust` crate boundaries and
  behavior rather than continue growing the prototype shape.

## Roadmap

### Phase 0: Freeze Decisions And Baseline

Goal: lock the porting contract before moving code.

Tasks:

- Confirm the open questions at the bottom of this document.
- Add `docs/RUST_PARITY.md` from `claw-rust/PARITY.md`, renamed for Solarcido.
- Record the exact local `claw-rust/` snapshot used for the port.
- Decide whether existing four-crate prototype code is kept, replaced, or
  merged module-by-module.

Exit checks:

```bash
cargo build --workspace
cargo test --workspace
```

### Phase 1: Workspace Reshape

Goal: match the reference crate boundaries.

Tasks:

- Add `commands`, `plugins`, `telemetry`, `compat-harness`, and
  `mock-solar-service` crates.
- Rename `rusty-claude-cli` concepts to `solarcido-cli`.
- Move slash command definitions out of `solarcido-cli`.
- Keep the root `Cargo.toml` workspace clean and exclude `claw-rust/`.

Exit checks:

```bash
cargo metadata --no-deps
cargo build --workspace
```

### Phase 2: Solar API Adapter

Goal: port the provider layer while preserving Solar behavior.

Tasks:

- Port streaming abstractions from `claw-rust/crates/api`.
- Implement OpenAI-compatible Solar request/response builders.
- Add provider error normalization.
- Add usage extraction.
- Add request preflight where provider-neutral.
- Add deterministic mock Solar responses for text, tool calls, streaming,
  provider errors, and usage.

Exit checks:

```bash
cargo test -p solarcido-api
cargo test -p mock-solar-service
```

### Phase 3: Runtime Core

Goal: replace the prototype loop with claw-style runtime behavior.

Tasks:

- Port session state and message history.
- Port streaming display event flow.
- Port multi-tool turn handling.
- Port system prompt assembly.
- Port usage and cost tracking.
- Port session persistence and resume.
- Keep Solar-specific provider/model text.

Exit checks:

```bash
cargo test -p solarcido-runtime
cargo run -p solarcido-cli -- --output-format json status
```

### Phase 4: Tools And Permissions

Goal: reach real local coding-agent parity for core tools.

Tasks:

- Port file tools and their edge-case tests.
- Port bash execution, timeout, background behavior, validation, and permission
  modules.
- Port grep/glob behavior and truncation rules.
- Port todo, notebook, tool search, web, sleep, structured output, config, REPL,
  PowerShell, and LSP surfaces.
- Add stubs only for lower-priority tools that are represented in
  `docs/RUST_PARITY.md`.

Exit checks:

```bash
cargo test -p solarcido-tools
cargo test -p solarcido-runtime
```

### Phase 5: CLI And REPL Parity

Goal: make the binary feel like claw with Solarcido branding.

Tasks:

- Port direct commands.
- Port REPL input handling and slash command dispatch.
- Port JSON/text output formatting.
- Port status, sandbox, system-prompt, agents, mcp, skills, and doctor surfaces.
- Keep `run` as a compatibility alias.

Exit checks:

```bash
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- status --output-format json
cargo run -p solarcido-cli -- version --output-format json
```

### Phase 6: Config, Sessions, Memory

Goal: make repeated local use stable.

Tasks:

- Port config loading and merge precedence.
- Implement Solarcido state paths.
- Port session listing, switching, fork/delete behavior if retained.
- Port memory/instruction loading with Solarcido names.
- Do not auto-load `.claw.json`; if needed later, add an explicit one-way
  import command that converts it to `.solarcido.json`.

Exit checks:

```bash
cargo test -p solarcido-runtime config
cargo test -p solarcido-cli session
```

### Phase 7: MCP, Plugins, Hooks, Skills

Goal: port the extension system.

Tasks:

- Port MCP lifecycle and tool bridge.
- Port plugin manager and command surfaces.
- Port hooks list/run behavior.
- Port skills inventory/install/invoke behavior.
- Ensure mutating extension tools are permission-gated.

Exit checks:

```bash
cargo test -p solarcido-runtime mcp
cargo test -p solarcido-plugins
cargo run -p solarcido-cli -- mcp --output-format json
```

### Phase 8: Mock Parity Harness

Goal: prove behavior with deterministic scenarios.

Tasks:

- Build and run the mock Solar service.
- Port the clean-environment CLI harness.
- Port the parity diff/checklist script.
- Keep `docs/RUST_PARITY.md` honest with real/stub/deferred status.
- Include agent, team, and cron scenarios in the first migration harness when
  the corresponding `claw-rust` behavior exists.

Exit checks:

```bash
./scripts/run_mock_parity_harness.sh
python scripts/run_mock_parity_diff.py
```

### Phase 9: Migration Gate

Goal: decide whether Rust replaces the TypeScript CLI.

Required before switching install/docs to Rust:

- `cargo build --workspace` passes.
- `cargo test --workspace` passes.
- Mock parity harness passes.
- Core one-shot and REPL manual smoke tests pass against real Solar API.
- README documents Rust commands and Solar env vars.
- TypeScript CLI retirement plan is documented, with removal handled in a
  separate explicit cleanup after Rust is accepted.

Manual smoke tests:

```bash
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- status --output-format json
cargo run -p solarcido-cli -- prompt "summarize this repository" --cwd .
cargo run -p solarcido-cli -- --permission-mode read-only prompt "show the files in this repo" --cwd .
```

## Closed Decisions

These choices are now part of the Rust port contract:

1. State path: Solarcido writes `.solarcido`/`.solarcido.json` and
   `~/.solarcido`, not `.claw`.
2. Default permission mode: `danger-full-access`.
3. Config compatibility: port claw config behavior, but rename active Solarcido
   config paths and schema names. `.claw.json` can be supported later through an
   explicit import flow, not automatic active config loading.
4. Web tools: follow `claw-rust` behavior. If the reference requires an
   external provider that Solarcido has not configured, implement a clear stub
   or provider-selection error and track it in `docs/RUST_PARITY.md`.
5. Model aliases: exact Solar model names only.
6. TypeScript lifecycle: after Phase 9, retire/remove the TypeScript CLI in a
   separate explicit cleanup rather than maintaining it as a long-term fallback.
7. Plugins/skills branding: fully rename schema and public metadata to
   Solarcido-owned names.
8. Agent/team/cron priority: follow `claw-rust`; include these in the first
   migration release when the reference behavior exists, otherwise document the
   smallest working Solarcido-native fallback.
