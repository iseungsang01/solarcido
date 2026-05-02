# Solarcido

`solarcido` is a direct coding CLI built on Upstage Solar. It works like a terminal coding assistant: you describe a task, it inspects the repository, edits files, searches code, runs commands, and verifies work inside the working directory.

## Quick start

Set your Upstage API key:

```bash
export UPSTAGE_API_KEY="your_key"
```

Run Solarcido:

```bash
solarcido
```

Development install:

```bash
npm install
npm run build
npm start
```

## Usage

Interactive mode accepts free-form prompts:

```txt
solarcido> fix the TypeScript errors in src/cli.ts
solarcido> inspect the tool registry and tighten the path checks
solarcido> update README to match the current behavior
```

You can also run a single task directly:

```bash
solarcido run "refactor the command parser" --cwd . --reasoning high
```

Persistent defaults live in `~/.solarcido/config.json`, or under
`SOLARCIDO_HOME/config.json` when `SOLARCIDO_HOME` is set:

```bash
solarcido config get
solarcido config set sandbox workspace-write
solarcido config path
solarcido sessions list
solarcido sessions show <id>
```

## Options

- `--cwd`: working directory, default `process.cwd()`
- `--reasoning`: `low | medium | high`
- `--model`: model to use for the coding assistant
- `--approval-policy`: `never | on-failure | on-request`
- `--sandbox`: `read-only | workspace-write`
- `--quiet`: suppress assistant chat messages

## Config

Solarcido loads persistent defaults from `~/.solarcido/config.json`:

```json
{
  "model": "solar-pro3-260323",
  "reasoningEffort": "high",
  "approvalPolicy": "on-failure",
  "sandbox": "workspace-write",
  "quiet": false
}
```

CLI flags override config values. `SOLARCIDO_HOME` can relocate the config and
session directories.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Rust port

The Rust CLI under `crates/` remains available for comparison and parity work.
During development, you can still run it with Cargo:

```bash
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- prompt "summarize this repository" --cwd .
cargo run -p solarcido-cli -- --resume latest prompt "continue"
```

## Notes

- The default model is `solar-pro3-260323`.
- The assistant uses repository tools for file listing, code search, line-window reads, focused string edits, whole-file writes, command execution, and task completion.
- For change requests, the workflow rejects a premature `finish` until a file edit or write has succeeded, so the assistant cannot stop at expected actions only.
- Command failures are returned to the assistant as structured output instead of crashing the workflow.
- The assistant runs until it calls `finish`, is interrupted, or hits an external runtime/API limit.
- File tools are constrained to the selected working directory.
- The project architecture and implementation rules are defined in `docs/SPEC.md`.
- The implementation sequence is tracked in `docs/ROADMAP.md`.
