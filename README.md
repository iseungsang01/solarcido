# Solarcido

`solarcido` is a direct coding CLI built on Upstage Solar. It works like a terminal coding assistant: you describe a task, it inspects the repository, edits files, searches code, runs commands, and verifies work inside the working directory.

## Quick start

MacOS/Linux (Recommended):

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
npm run build
npm run dev
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
solarcido run "refactor the command parser" --cwd . --max-steps 8 --reasoning medium
```

Persistent defaults are stored in `~/.solarcido/config.json`:

```bash
solarcido config path
solarcido config get
solarcido config get model
solarcido config set model solar-pro3-260323
solarcido config set maxSteps 12
```

Workflow runs write compact session metadata under `~/.solarcido/sessions/`:

```bash
solarcido sessions list
solarcido sessions show <id>
```

## Options

- `--cwd`: working directory
- `--max-steps`: assistant step limit
- `--reasoning`: `low | medium | high`
- `--model`: model to use for the coding assistant
- `--approval-policy`: `never | on-failure | on-request`
- `--sandbox`: `read-only | workspace-write`
- `--quiet`: suppress assistant chat messages

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Notes

- The default model is `solar-pro3-260323`.
- The assistant uses repository tools for file listing, code search, line-window reads, focused string edits, whole-file writes, command execution, and task completion.
- Command failures are returned to the assistant as structured output instead of crashing the workflow.
- File tools are constrained to the selected working directory.
- The project architecture and implementation rules are defined in `docs/SPEC.md`.
- The implementation sequence is tracked in `docs/ROADMAP.md`.
