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
- **Phase 7 (MCP Foundation)**: Next. MCP server configuration and connection manager are not implemented yet.

## Implementation Details

- **Binary location**: `target/release/solarcido` (default) or `target/debug/solarcido`.
- **Entry point**: `src/main.rs` in the `solarcido-cli` crate.
- **Tool modules**: `crates/tools/src/` contains implementations for all file and command tools.
- **Config module**: `crates/runtime/src/config.rs` handles Rust config loading and validation.
- **Approval module**: `crates/runtime/src/lib.rs` handles permission policy enforcement.
- **Session module**: `crates/runtime/src/session.rs` manages JSONL session snapshots.
- **MCP module**: not implemented yet; planned for the next phase.

## Recent Changes

- Added support for `--resume` flag to continue previous sessions.
- Updated npm bin wrapper to prefer the Rust binary.
- Fixed edge cases in `edit_file` ambiguity handling.
- Added `run_command` exit code, stdout, and stderr reporting.
- Integrated sandbox mode into command execution pipeline.
- Added `~/.solarcido/config.json` loading with strict validation.
- Added `solarcido config`, `solarcido sessions`, and `solarcido memory`.
- Added optional `~/.solarcido/memory.md` injection into the active system prompt.

## Next Steps

1. Finish MCP server configuration and connection manager.
2. Add MCP tool adapter layer.
3. Add plugin, hook, and skill lifecycle support.
4. Build the mock parity harness.
5. Run final migration checks and prepare a stable Rust CLI release.

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
