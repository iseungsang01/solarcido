# Claw-Rust Spec Summary

This document provides a brief specification summary for each file in the `claw-rust` workspace. The summaries are based on file names, first lines, and typical responsibilities.

## Workspace Overview

- **Workspace root**: `Cargo.toml` defines the workspace members and dependencies.
- **Crate structure**: 9 crates covering API, commands, compatibility harness, mock service, plugins, runtime, CLI binary, telemetry, and tools.
- **Scripts**: Utility scripts for parity testing and mock service.
- **Documentation**: `README.md`, `CLAUDE.md`, `PARITY.md` provide high-level overviews.

## File List

### Workspace Files

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Workspace configuration: members = `crates/*`, dependencies = `serde_json`, lints (unsafe code forbid, clippy warnings). |
| `CLAUDE.md` | Project memory and guidance for Claw Code; includes formatting notes and workflow recommendations. |
| `README.md` | High-level overview of the Rust implementation, quick start, features, and workspace layout. |
| `PARITY.md` | Parity status tracking: behavioral coverage of tools, stubs, and migration readiness. |
| `scripts/run_mock_parity_harness.sh` | Bash wrapper to run the mock parity harness test suite. |
| `scripts/run_mock_parity_diff.py` | Python script to compare mock parity results against `PARITY.md` references. |
| `mock_parity_scenarios.json` | JSON manifest of parity scenarios and their expected references. |

### API Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | API crate configuration: dependencies include `reqwest`, `tokio`, `serde`, etc. |
| `src/client.rs` | Main API client handling Anthropic and OpenAI provider requests, streaming, and preflight checks. |
| `src/error.rs` | Error types and handling for API client operations. |
| `src/http_client.rs` | HTTP client implementation with retry logic and jitter. |
| `src/lib.rs` | Public API module exposing client functions and types. |
| `src/prompt_cache.rs` | In-memory prompt cache with TTL and hash-based eviction. |
| `src/providers/anthropic.rs` | Anthropic provider client with bearer token and API key handling. |
| `src/providers/openai_compat.rs` | OpenAI-compatible provider client supporting gpt-5* models. |
| `src/providers/mod.rs` | Provider registry mapping aliases to provider kinds. |
| `src/sse.rs` | Server-Sent Events client for streaming responses. |
| `src/types.rs` | Common types for API responses and request payloads. |
| `tests/client_integration.rs` | Integration tests for the API client. |
| `tests/openai_compat_integration.rs` | Integration tests for OpenAI compatibility. |
| `tests/provider_client_integration.rs` | Integration tests for provider client behavior. |
| `tests/proxy_integration.rs` | Tests for proxy integration. |

### Commands Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Commands crate configuration. |
| `src/lib.rs` | Slash command registry, parsing, and help text generation. |

### Compat-Harness Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Compatibility harness configuration. |
| `src/lib.rs` | Extracts tool/prompt manifests from upstream TypeScript source. |

### Mock Anthropic Service Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Mock service configuration. |
| `src/lib.rs` | Deterministic mock for `/v1/messages` endpoint. |
| `src/main.rs` | Main entry point for the mock service. |

### Plugins Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Plugins crate configuration. |
| `src/lib.rs` | Plugin metadata, install/enable/disable flows, and hook integration surfaces. |
| `src/hooks.rs` | Hook handling for plugin lifecycle events. |
| `src/test_isolation.rs` | Test isolation utilities for plugins. |

### Runtime Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Runtime crate configuration. |
| `src/bash_validation.rs` | Bash command validation (e.g., sed, path, read-only, destructive). |
| `src/bash.rs` | Bash tool execution with subprocess, timeout, background, sandbox. |
| `src/bootstrap.rs` | Bootstrap logic for session initialization. |
| `src/branch_lock.rs` | Branch lock management for concurrent operations. |
| `src/compact.rs` | Session compaction and cleanup logic. |
| `src/config_validate.rs` | Config validation and merging logic. |
| `src/config.rs` | Config loading and schema definitions. |
| `src/conversation.rs` | Conversation management and message handling. |
| `src/file_ops.rs` | File operations: read, write, edit, glob, grep, permission enforcement. |
| `src/git_context.rs` | Git context extraction for workspace-aware operations. |
| `src/green_contract.rs` | Green contract enforcement for permission levels. |
| `src/hooks.rs` | Hooks for tool usage and permission checks. |
| `src/json.rs` | JSON serialization/deserialization utilities. |
| `src/lane_events.rs` | Lane event handling for parallel execution. |
| `src/lib.rs` | Core runtime module exposing `ConversationRuntime`. |
| `src/lsp_client.rs` | LSP client for diagnostics, hover, definition, etc. |
| `src/mcp_client.rs` | MCP client for connecting to remote MCP servers. |
| `src/mcp_lifecycle_hardened.rs` | Hardened MCP lifecycle management. |
| `src/mcp_server.rs` | MCP server implementation for local testing. |
| `src/mcp_stdio.rs` | MCP stdio bridge for tool calls. |
| `src/mcp_tool_bridge.rs` | MCP tool invocation bridge. |
| `src/mcp.rs` | MCP protocol handling and state management. |
| `src/oauth.rs` | OAuth token handling for Anthropic. |
| `src/permission_enforcer.rs` | Permission enforcement across tools and commands. |
| `src/permissions.rs` | Permission definitions and matching logic. |
| `src/plugin_lifecycle.rs` | Plugin lifecycle management. |
| `src/policy_engine.rs` | Policy engine for permission decisions. |
| `src/prompt.rs` | System prompt assembly and management. |
| `src/recovery_recipes.rs` | Recovery recipes for error handling. |
| `src/remote.rs` | Remote server discovery and connection logic. |
| `src/sandbox.rs` | Sandbox execution for restricted commands. |
| `src/session_control.rs` | Session control and lifecycle management. |
| `src/session.rs` | Session persistence and resume logic. |
| `src/sse.rs` | SSE client for streaming events. |
| `src/stale_base.rs` | Stale base detection for sessions. |
| `src/stale_branch.rs` | Stale branch detection for Git contexts. |
| `src/summary_compression.rs` | Summary compression for conversation history. |
| `src/task_packet.rs` | Task packet handling for task creation and updates. |
| `src/task_registry.rs` | Task registry for in-memory task management. |
| `src/team_cron_registry.rs` | Team cron registry for scheduling tasks. |
| `src/trust_resolver.rs` | Trust resolver for permission subject extraction. |
| `src/usage.rs` | Usage tracking and token counting. |
| `src/worker_boot.rs` | Worker boot logic for session initialization. |
| `tests/integration_tests.rs` | Integration tests for runtime behavior. |

### Rusty Claude CLI Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | CLI binary configuration. |
| `src/init.rs` | Initialization logic for the CLI. |
| `src/input.rs` | Input handling with rustyline, tab completion, and history. |
| `src/main.rs` | Main REPL loop, slash command handlers, streaming display, tool call rendering, CLI argument parsing. |
| `src/render.rs` | Markdown rendering to terminal with syntax highlighting and formatting. |
| `tests/cli_flags_and_config_defaults.rs` | Tests for CLI flags and config defaults. |
| `tests/compact_output.rs` | Tests for compact output formatting. |
| `tests/mock_parity_harness.rs` | Mock parity harness tests for CLI behavior. |
| `tests/output_format_contract.rs` | Tests for output format contract. |
| `tests/resume_slash_commands.rs` | Tests for slash command resume functionality. |

### Telemetry Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Telemetry crate configuration. |
| `src/lib.rs` | Session trace events and telemetry payloads. |

### Tools Crate

| File | Spec Summary |
|------|--------------|
| `Cargo.toml` | Tools crate configuration. |
| `src/lib.rs` | Tool specs and execution: Bash, ReadFile, WriteFile, EditFile, GlobSearch, GrepSearch, WebSearch, WebFetch, Agent, TodoWrite, NotebookEdit, Skill, ToolSearch, and runtime-facing tool discovery. |
| `src/lane_completion.rs` | Lane completion utilities for tool execution. |
| `src/pdf_extract.rs` | PDF extraction tool. |

### Additional Files

| File | Spec Summary |
|------|--------------|
| `scripts/run_mock_parity_harness.sh` | Bash script to run the mock parity harness test suite. |
| `scripts/run_mock_parity_diff.py` | Python script to compare mock parity results against `PARITY.md` references. |
| `mock_parity_scenarios.json` | JSON manifest of parity scenarios and their expected references. |

---

*This summary is a living document; updates may be added as the codebase evolves.*