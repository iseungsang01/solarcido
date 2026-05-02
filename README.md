# Solarcido

`solarcido` is a direct coding CLI built on Upstage Solar. It works like a terminal coding assistant: you describe a task, it inspects the repository, edits files, searches code, runs commands, and verifies work inside the working directory.

## Quick start

MacOS/Linux (Recommended, requires Rust/Cargo):

```bash
curl -fsSL https://raw.githubusercontent.com/iseungsang01/solarcido/main/install.sh | bash
```

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
npm run build:rust
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
solarcido run "refactor the command parser" --cwd . --reasoning-effort medium
```

Rust sessions are saved as JSONL under `<repo>/.solarcido/sessions/`:

```bash
solarcido --resume latest prompt "continue"
solarcido status
solarcido init
```

Persistent defaults live in `~/.solarcido/config.json`, or under
`SOLARCIDO_HOME/config.json` when `SOLARCIDO_HOME` is set:

```bash
solarcido config get
solarcido config set sandbox workspace-write
solarcido config path
solarcido sessions list
solarcido sessions show latest
solarcido memory
```

The same config file can also hold MCP server settings under an `mcp` block;
`solarcido mcp` reports the configured servers.

The TypeScript sources remain in the repo for compatibility checks, but the
supported CLI entrypoints now launch the Rust binary:

```bash
npm run build
node dist/index.js --help
```

## Options

- `--cwd`: working directory
- `--reasoning-effort`: `low | medium | high`
- `--model`: model to use for the coding assistant
- `--max-output-tokens`: maximum response tokens to request from Solar Pro, default `4096`
- `--permission-mode`: `read-only | workspace-write | danger-full-access`
- `--output-format`: `text | json`
- `--resume`: `latest`, a session id, or a `.jsonl` session path

## Config and memory

Rust Solarcido loads persistent defaults from `~/.solarcido/config.json`:

```json
{
  "model": "solar-pro3-260323",
  "reasoningEffort": "medium",
  "approvalPolicy": "on-failure",
  "sandbox": "workspace-write",
  "quiet": false
}
```

CLI flags override config values. `SOLARCIDO_MODEL` and
`SOLARCIDO_MAX_OUTPUT_TOKENS` remain supported for environment overrides.
Optional global memory is read from `~/.solarcido/memory.md` and appended to the
active system prompt when present.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Rust port

The Rust CLI under `crates/` is now the default `solarcido` entrypoint. During
development, you can still run it with Cargo:

```bash
cargo run -p solarcido-cli -- --help
cargo run -p solarcido-cli -- prompt "summarize this repository" --cwd .
cargo run -p solarcido-cli -- --resume latest prompt "continue"
```

The npm bin wrapper targets the Rust CLI by default, preferring an existing
`target/release/solarcido` or `target/debug/solarcido` binary and falling back
to `cargo run -p solarcido-cli --` when no compiled binary is present.

## Notes

- The default model is `solar-pro3-260323`.
- Solar Pro's model context window is fixed by the provider. Solarcido defaults to a 4K output budget so more of that window is available for prompts, session history, and tool results. Set `--max-output-tokens` or `SOLARCIDO_MAX_OUTPUT_TOKENS` when you need a different output budget.
- The assistant uses repository tools for file listing, code search, line-window reads, focused string edits, whole-file writes, command execution, and task completion.
- For change requests, the workflow rejects a premature `finish` until a file edit or write has succeeded, so the assistant cannot stop at expected actions only.
- Command failures are returned to the assistant as structured output instead of crashing the workflow.
- The assistant runs until it calls `finish`, is interrupted, or hits an external runtime/API limit.
- File tools are constrained to the selected working directory.
- The project architecture and implementation rules are defined in `docs/SPEC.md`.
- The implementation sequence is tracked in `docs/ROADMAP.md`.
