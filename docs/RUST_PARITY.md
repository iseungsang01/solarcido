# Parity Status — Solarcido Rust Port

Last updated: 2026-05-02

Adapted from `claw-rust/PARITY.md`. This file tracks behavioral parity between
the Solarcido Rust workspace (`crates/`) and the reference `claw-rust/`
implementation. Entries are honest: real means tested or manually verified, stub
means the surface compiles but returns placeholder output.

## Workspace Shape

Target layout from `docs/RUST_PORT.md`:

| Crate | Status | Notes |
|-------|--------|-------|
| `api` | real | Solar/OpenAI-compatible client, SSE streaming, error normalization, 17 tests |
| `commands` | real | Slash command registry, parser, help rendering (text + JSON), 4 tests |
| `compat-harness` | skeleton | Types + stub `extract_manifest` — deferred to Phase 8 |
| `mock-solar-service` | partial | Scenario types, completion/SSE builders, builtin scenarios — HTTP server stub only |
| `plugins` | skeleton | Metadata types, stub registry/manager — deferred to Phase 7 |
| `runtime` | real | ConversationRuntime, permission policy, streaming + non-streaming turn execution, JSONL session snapshots, usage/cost tracking (7 tests) |
| `solarcido-cli` | real | Default `solarcido` entrypoint, CLI parsing, one-shot prompt, REPL with streaming, `--resume`, full slash dispatch, 11 CLI subcommands |
| `telemetry` | real | Session tracer, JSONL + memory sinks, token usage, event types |
| `tools` | real | 11 tools: bash, read/write/edit_file, glob/grep_search, Sleep, StructuredOutput, SendUserMessage, ToolSearch, TodoWrite |

## Tool Surface

### Real Implementations

| Tool | Location | Behavioral Notes |
|------|----------|-----------------|
| **bash** | `tools::WorkspaceTools` | subprocess exec, timeout, Windows PowerShell + Unix sh — basic parity |
| **read_file** | `tools::WorkspaceTools` | offset/limit read, size limit, path traversal prevention — good parity |
| **write_file** | `tools::WorkspaceTools` | create/overwrite, size limit, parent dir creation — good parity |
| **edit_file** | `tools::WorkspaceTools` | old/new string replacement, replace_all, ambiguity rejection — good parity |
| **glob_search** | `tools::WorkspaceTools` | glob pattern matching, workspace scoping, truncation at 100 — good parity |
| **grep_search** | `tools::WorkspaceTools` | regex search, glob filter, output modes (files/content/count), case insensitive — good parity |
| **Sleep** | `tools::WorkspaceTools` | duration_ms with 120s max cap — good parity |
| **StructuredOutput** | `tools::WorkspaceTools` | passthrough JSON data — good parity |
| **SendUserMessage** | `tools::WorkspaceTools` | message + status level — good parity |
| **ToolSearch** | `tools::WorkspaceTools` | keyword search across registered tool specs — good parity |
| **TodoWrite** | `tools::WorkspaceTools` | accept/return todo list (no persistence yet) — moderate parity |

### Not Yet Implemented

| Tool | Status | Priority |
|------|--------|----------|
| **WebFetch** | not started | Phase 4 |
| **WebSearch** | not started | Phase 4 |
| **NotebookEdit** | not started | Phase 4 |
| **Config** | not started | Phase 4 |
| **Agent** | not started | Phase 4 |
| **TaskCreate** | not started | Phase 4 |
| **TaskGet** | not started | Phase 4 |
| **TaskList** | not started | Phase 4 |
| **TaskStop** | not started | Phase 4 |
| **TaskUpdate** | not started | Phase 4 |
| **TaskOutput** | not started | Phase 4 |
| **TeamCreate** | not started | Phase 4 |
| **TeamDelete** | not started | Phase 4 |
| **CronCreate** | not started | Phase 4 |
| **CronDelete** | not started | Phase 4 |
| **CronList** | not started | Phase 4 |
| **LSP** | not started | Phase 4 |
| **ListMcpResources** | not started | Phase 4 |
| **ReadMcpResource** | not started | Phase 4 |
| **MCP** | not started | Phase 4 |
| **McpAuth** | not started | Phase 7 |
| **REPL** | not started | Phase 4 |
| **PowerShell** | not started | Phase 4 |

## Slash Commands: 22 specs / 22 wired handlers

All 22 slash command specs are registered in `crates/commands` and all 22 have
REPL dispatch handlers in `solarcido-cli`. Real handlers with functional output:

- `/help` — renders full slash command help from registry
- `/status` — shows model, permission mode, reasoning effort, turns
- `/sandbox` — shows permission mode and OS sandbox status
- `/model [name]` — shows current model (switching deferred)
- `/permissions [mode]` — shows current mode (switching deferred)
- `/clear` — clears terminal via ANSI escape
- `/cost` — shows cumulative token usage with cost estimate
- `/version` — prints version
- `/exit` (`/quit`) — exits the REPL

Stub handlers (return "not yet implemented" messages):

`/compact`, `/resume`, `/config`, `/mcp`, `/memory`, `/init`, `/diff`,
`/session`, `/plugin`, `/agents`, `/skills`, `/doctor`, `/hooks`

## CLI Commands

| Command | Status | Notes |
|---------|--------|-------|
| `prompt <text>` | real | One-shot with streaming output |
| `run <text>` | real | Compatibility alias for prompt |
| `status` | real | Text + JSON output |
| `help` | real | Text + JSON output, includes slash command JSON |
| `version` | real | Text + JSON output |
| `sandbox` | real | Text + JSON output with permission mode and OS sandbox note |
| `agents` | real | Text + JSON output (stub: no agents configured) |
| `mcp` | real | Text + JSON output (stub: no servers configured) |
| `skills` | real | Text + JSON output (stub: no skills installed) |
| `system-prompt` | real | Text + JSON output, prints active system prompt |
| `init` | real | Creates `.solarcido/` dir and `.solarcido.json` config |

Global option status:

- `--resume [SESSION.jsonl|session-id|latest]` is real for one-shot prompt and
  REPL startup. Sessions are stored under `<repo>/.solarcido/sessions/`.
- `package.json` and `install.sh` now route `solarcido` to the Rust binary by
  default. The TypeScript CLI remains available through `node dist/index.js`
  for compatibility work.

## Runtime Capabilities

| Capability | Status | Notes |
|------------|--------|-------|
| Multi-turn session state | real | In-memory and JSONL snapshot-backed |
| Streaming assistant output | real | SSE frame parser + SolarStream; tool-call JSON deltas are accumulated before execution |
| Tool-call loop (multi-tool per turn) | real | Up to 128 iterations |
| Structured tool results | real | Fed back to model |
| Permission enforcement | real | 3 modes + interactive prompter |
| Session persistence and resume | real | Workspace-local JSONL snapshots, `latest` pointer, `--resume latest|id|path` |
| Config loading and merge precedence | not started | Phase 6 |
| MCP server lifecycle | not started | Phase 7 |
| Plugin and hook integration | not started | Phase 7 |
| Usage and cost accounting | real | TokenUsage, ModelPricing, UsageCostEstimate, UsageTracker with cumulative tracking and cost summary lines (5 tests) |
| System prompt assembly | partial | Static prompt only; no memory/config/tool injection |

## Permission and Sandbox

| Feature | Status |
|---------|--------|
| `read-only` mode | real |
| `workspace-write` mode | real |
| `danger-full-access` mode | real |
| `--dangerously-skip-permissions` | real |
| Interactive permission prompt (REPL) | real |
| Non-interactive denial (JSON output) | not started |
| OS-level sandboxing | not started |

## Config and State

| Feature | Status |
|---------|--------|
| `~/.solarcido/` state directory | not started |
| `~/.solarcido/config.json` | not started |
| `~/.solarcido/sessions/` | not started |
| `<repo>/.solarcido/` | real | Created by `solarcido init` |
| `<repo>/.solarcido/sessions/` | real | Created by `solarcido init` and prompt/REPL session saves |
| `<repo>/.solarcido.json` | real | Created by `solarcido init` with default model |
| Config merge precedence | not started |

## Mock Parity Harness

| Artifact | Status |
|----------|--------|
| `crates/mock-solar-service/` library | partial (types + builders, no HTTP server) |
| `crates/mock-solar-service/` HTTP binary | stub (prints scenario list and exits) |
| `crates/solarcido-cli/tests/mock_parity_harness.rs` | not started |
| `scripts/run_mock_parity_harness.sh` | not started |
| `scripts/run_mock_parity_diff.py` | not started |
| `mock_parity_scenarios.json` | not started |

### Builtin Mock Scenarios (library only, not harness-tested)

- `streaming_text`
- `read_file_roundtrip`
- `write_file_allowed`
- `bash_stdout_roundtrip`

### Required Scenarios (from RUST_PORT.md, not yet implemented)

- `grep_chunk_assembly`
- `write_file_denied`
- `multi_tool_turn_roundtrip`
- `bash_permission_prompt_approved`
- `bash_permission_prompt_denied`
- `plugin_tool_roundtrip`
- `session_resume_roundtrip`
- `mcp_tool_roundtrip`

## Telemetry

| Feature | Status |
|---------|--------|
| Session trace records | real |
| JSONL file sink | real |
| Memory sink (tests) | real |
| Token usage tracking | real |
| Cost calculation | real | ModelPricing with Solar tier, per-model pricing lookup, USD formatting |
| Analytics events | types defined, no emitter |

## Provider Contract

| Requirement | Status |
|-------------|--------|
| Default model: `solar-pro3-260323` | real |
| API key env: `UPSTAGE_API_KEY` | real |
| Base URL env: `UPSTAGE_BASE_URL` | real |
| Default base URL: `https://api.upstage.ai/v1` | real |
| OpenAI-compatible chat completions | real |
| `reasoning_effort` parameter | real |
| Provider error normalization | real |
| Never log API keys | real |

## Phase Completion Status

| Phase | Goal | Status |
|-------|------|--------|
| 0 — Freeze Decisions | Lock porting contract | complete |
| 1 — Workspace Reshape | Match reference crate boundaries | complete |
| 2 — Solar API Adapter | Provider layer with Solar behavior | complete |
| 3 — Runtime Core | Replace prototype with claw-style runtime | partial (session persistence/resume and usage/cost done; config-backed prompt assembly pending) |
| 4 — Tools and Permissions | Real local coding-agent parity | partial (11/40 tools) |
| 5 — CLI and REPL Parity | Binary feels like claw with Solarcido branding | partial (11 CLI commands, 22/22 slash handlers wired) |
| 6 — Config, Sessions, Memory | Repeated local use stable | not started |
| 7 — MCP, Plugins, Hooks, Skills | Extension system | not started |
| 8 — Mock Parity Harness | Deterministic scenario proof | not started |
| 9 — Migration Gate | Rust replaces TypeScript CLI | not started |
