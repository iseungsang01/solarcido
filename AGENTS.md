# Solarcido Agent Instructions

These instructions apply to the whole repository.

## Project Shape

Solarcido is a TypeScript CLI coding assistant built for using Upstage Solar API.

- The tight project spec lives in `docs/SPEC.md`.
- The implementation order lives in `docs/ROADMAP.md`.
- Source code lives in `src/`.
- Built output goes to `dist/`.
- The CLI entrypoint is `src/index.ts`.
- The direct agent loop lives in `src/workflow/run-agent-loop.ts`.
- Tool definitions and dispatch live in `src/tools/registry.ts`.
- File and command tool implementations live in `src/tools/filesystem.ts` and `src/tools/process.ts`.
- Solar API client configuration lives in `src/solar/`.

## General Workflow

- Read the existing code before changing behavior.
- Check `docs/SPEC.md` before adding commands, tools, config behavior, approval policy, sandbox behavior, or MCP support.
- Follow `docs/ROADMAP.md` for implementation order unless the user explicitly asks to reprioritize.
- Keep edits small and aligned with the current module boundaries.
- Prefer changing the tool implementation layer when adding assistant capabilities, then expose them through `src/tools/registry.ts`.
- Do not copy unrelated Codex or codex-rs code into this repo. Adapt the behavior to Solarcido's TypeScript CLI shape.
- Do not modify generated `dist/` files directly. Change `src/` and run the build.
- Preserve user changes in the working tree. Do not revert unrelated edits.

## Commands

Install missing repo tools or dependencies before running project instructions when they are required.

Common commands:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
node dist/index.js --help
```

Run `npm run typecheck` after TypeScript changes. Run `npm test` when changing CLI parsing, config, tools, or command behavior. Run `npm run build` before finalizing changes that affect runtime behavior.

## TypeScript Style

- Use strict TypeScript and keep exported types explicit.
- Prefer `unknown` plus narrow validation over `any`.
- Prefer small, focused functions when they are reused or clarify tool behavior.
- Do not add small helper functions that are referenced only once unless they materially improve readability.
- Avoid boolean or ambiguous optional parameters in new public APIs when a named options object would make callsites clearer.
- Keep modules reasonably sized. If a file starts becoming a catch-all, add a new module instead of growing it further.
- Prefer exhaustive `switch` handling for known command/tool names where practical.
- When formatting strings, use template literals with directly inlined variables.
- Keep comments sparse and useful. Comment non-obvious behavior, not line-by-line mechanics.

## Tooling And Agent Behavior

- Tool calls must stay inside the selected working directory.
- Path handling should use `path.resolve` / `path.relative` checks rather than ad hoc string checks.
- Prefer focused edit tools over whole-file rewrites for small changes.
- Command failures should be returned to the assistant as structured output when possible instead of crashing the workflow.
- When adding a tool:
  - Add its JSON schema in `src/tools/registry.ts`.
  - Add argument validation before calling implementation code.
  - Return concise, model-readable output.
  - Keep the implementation in an appropriate module under `src/tools/`.
- If a tool can fail because of user input, return an `ERROR:` tool result where the loop can continue unless the failure should abort the CLI itself.

## CLI And Interactive Shell

- Keep `src/cli.ts` and `README.md` in sync when adding CLI flags or commands.
- Keep `src/interactive.ts` slash command help in sync with implemented slash commands.
- Interactive UI should remain terminal-friendly and avoid dependencies unless there is a clear reason.
- Do not make cosmetic rewrites to the interactive shell while changing unrelated behavior.

## API And Environment

- `UPSTAGE_API_KEY` is required for real model calls.
- The default model is defined in `src/solar/constants.ts`.
- Do not hardcode API keys or local secrets.
- Do not add or modify sandbox-related environment variable behavior unless the requested Solarcido feature explicitly needs it.

## Tests And Verification

- For TypeScript-only changes, run:

```bash
npm run typecheck
```

- For behavior changes that should run from the published CLI output, run:

```bash
npm run build
node dist/index.js --help
```

- If adding tests later, prefer testing whole returned objects or observable CLI/tool behavior rather than asserting unrelated implementation details field by field.

## Documentation

- Update `README.md` when user-visible behavior, CLI flags, environment requirements, or tool capabilities change.
- Keep documentation focused on Solarcido behavior. Do not document Codex-only, Rust-only, Bazel-only, or TUI-only workflows unless those systems are actually added to this repository.
