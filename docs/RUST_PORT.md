# Rust Port Progress

## Overview

The Rust port of Solarcido is the default CLI entrypoint. It replaces the Node.js implementation as the primary tool for repository inspection, file editing, command execution, and session management.

## Current Status

- **Phase 0 (Baseline)** – Completed. The Rust CLI (`crates/solarcido-cli`) is functional and passes all baseline tests.
- **Phase 1 (Core Contracts)** – Completed. Core tool contracts (list, read, search, write, edit, command, finish) are stable and tested.
- **Phase 2 (Config System)** – Completed. Config loading and validation are implemented in Rust, with support for `~/.solarcido/config.json`.
- **Phase 3 (Approval Policy)** – Completed. Command classification and policy enforcement are in place.
- **Phase 4 (Sandbox Semantics)** – Completed. `read-only` and `workspace-write` sandbox modes are enforced.
- **Phase 5 (Better Agent Sessions)** – Completed. Session metadata is stored under `~/.solarcido/sessions/`.
- **Phase 6 (MCP Foundation)** – In progress. MCP server configuration and connection manager are being built.

## Implementation Details

- **Binary location**: `target/release/solarcido` (default) or `target/debug/solarcido`.
- **Entry point**: `src/main.rs` in the `solarcido-cli` crate.
- **Tool modules**: `src/tools/` contains implementations for all file and command tools.
- **Config module**: `src/config/` handles loading and validation.
- **Approval module**: `src/approvals/` classifies commands and enforces policies.
- **Session module**: `src/sessions/` manages session metadata.
- **MCP module**: `src/mcp/` under development.

## Recent Changes

- Added support for `--resume` flag to continue previous sessions.
- Updated npm bin wrapper to prefer the Rust binary.
- Fixed edge cases in `edit_file` ambiguity handling.
- Added `run_command` exit code, stdout, and stderr reporting.
- Integrated sandbox mode into command execution pipeline.

## Next Steps

1. Finish MCP server configuration and connection manager.
2. Add MCP tool adapter layer.
3. Update documentation (`README.md`, `docs/SPEC.md`) to reflect MCP capabilities.
4. Run final exit checks and ensure help text matches.
5. Deploy a stable release of the Rust CLI.

## Verification

Run the following commands to verify the Rust port is working:

```bash
cargo test --workspace
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- prompt "summarize this repository" --cwd .
cargo run -p solarcido-cli -- --resume latest prompt "continue"
```