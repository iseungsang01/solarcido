# Rust Port Progress

## Overview

The Rust port of Solarcido is the default CLI entrypoint. It replaces the Node.js implementation as the primary tool for repository inspection, file editing, command execution, and session management.

## Current Status

- **Phase 0 (Baseline)**: Completed. The Rust CLI (`crates/solarcido-cli`) is functional and passes all baseline tests.
- **Phase 1 (Core Contracts)**: Completed. Core tool contracts (list, read, search, write, edit, command, finish) are stable and tested.
- **Phase 2 (Config System)**: Completed. Config loading and validation are implemented in Rust, with support for `~/.solarcido/config.json`.
- **Phase 3 (Approval Policy)**: Completed. Command classification and policy enforcement are in place.
- **Phase 4 (Sandbox Semantics)**: Completed. `read-only` and `workspace-write` sandbox modes are enforced.
- **Phase 5 (Better Agent Sessions)**: Completed. Session metadata is stored under workspace `.solarcido/sessions/`.
- **Phase 6 (Config, Sessions, Memory)**: Completed. Rust config loading, config commands, session inspection, and optional global memory are wired.
- **Phase 7 (MCP Foundation)**: Completed. MCP server configuration, connection manager scaffolding, and the tool adapter layer are in place.

## Phase 7: MCP Foundation

Status: completed.

Goal: add MCP support without spreading MCP-specific logic through the rest of the app.

Scope:

- Add a dedicated MCP module for server config and lifecycle management.
- Centralize MCP tool mutation and call mutation in one connection manager.
- Add the MCP tool adapter layer.
- Keep MCP server config under the persistent Solarcido config model.

Non-goals:

- Do not wire MCP logic directly into unrelated runtime paths.
- Do not claim MCP mutating tools are available without explicit approval handling.
- Do not move on to parity harness work before MCP config and approval behavior are stable.

Exit checks:

```bash
cargo test --workspace
cargo run -p solarcido-cli -- --help
```

## Phase 8: Mock Parity Harness

Status: completed.

Goal: prove the Rust port matches reference behavior through deterministic scenario tests.

Scope:

- Turn `mock-solar-service` into a working HTTP mock server.
- Add a parity harness for scripted CLI scenarios.
- Cover the key round trips for streaming, file operations, permissions, sessions, and MCP.
- Compare Rust port output against the reference `claw-rust` behavior.

Implemented so far:

- Working mock server and CLI parity harness for the file/tool round trips.
- Separate checks for session resume and MCP config listing.
- Parity manifest and diff script for the runnable scenario set.

Non-goals:

- Do not add new product features here.
- Do not treat the harness as a runtime dependency for normal CLI use.
- Do not expand extension-system behavior until Phase 7 is complete.

Exit checks:

```bash
cargo test --workspace
```

## Phase 9: Migration Gate

Status: completed.

Goal: decide whether the Rust CLI is ready to replace the TypeScript CLI as the supported default.

Scope:

- Verify the Rust CLI is stable enough for normal use.
- Confirm help text, install instructions, and wrapper scripts point at the Rust binary.
- Clean up any remaining compatibility gaps that block release.
- Treat the TypeScript CLI as legacy-only compatibility until it is explicitly removed.
- Keep the Rust CLI as the supported default entrypoint.

Non-goals:

- Do not advance this phase until Phase 7 and Phase 8 are complete.
- Do not remove compatibility paths before the Rust CLI is proven stable.

Exit checks:

```bash
cargo test --workspace
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- config get
cargo run -p solarcido-cli -- sessions list
```

## Implementation Details

- **Binary location**: `target/release/solarcido` (default) or `target/debug/solarcido`.
- **Entry point**: `src/main.rs` in the `solarcido-cli` crate.
- **Tool modules**: `crates/tools/src/` contains implementations for all file and command tools.
- **Config module**: `crates/runtime/src/config.rs` handles Rust config loading and validation.
- **Approval module**: `crates/runtime/src/lib.rs` handles permission policy enforcement.
- **Session module**: `crates/runtime/src/session.rs` manages JSONL session snapshots.
- **MCP module**: `crates/runtime/src/mcp.rs` provides config types, server state, and an in-memory connection manager foundation.

## Recent Changes

- Added support for `--resume` flag to continue previous sessions.
- Updated npm bin wrapper to prefer the Rust binary.
- Fixed edge cases in `edit_file` ambiguity handling.
- Added `run_command` exit code, stdout, and stderr reporting.
- Integrated sandbox mode into command execution pipeline.
- Added `~/.solarcido/config.json` loading with strict validation.
- Added `solarcido config`, `solarcido sessions`, and `solarcido memory`.
- Added optional `~/.solarcido/memory.md` injection into the active system prompt.
- Added MCP config scaffolding, an in-memory connection manager foundation, and a tool adapter layer.

## Verification

Run the following commands to verify the Rust port is working:

```bash
cargo test --workspace
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- config get
cargo run -p solarcido-cli -- sessions list
cargo run -p solarcido-cli -- prompt "summarize this repository" --cwd .
cargo run -p solarcido-cli -- --resume latest prompt "continue"
```
