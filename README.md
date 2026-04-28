# Solarcido

`solarcido` is a direct coding CLI built on Upstage Solar. It works like a terminal coding assistant: you describe a task, it inspects the repository, edits files, and can run commands inside the working directory.

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

## Options

- `--cwd`: working directory
- `--max-steps`: assistant step limit
- `--reasoning`: `low | medium | high`
- `--model`: model to use for the coding assistant

## Notes

- The default model is `solar-pro3-260323`.
- The assistant uses repository tools for file inspection, edits, command execution, and task completion.
- Use `npm run typecheck` to verify the build locally.
