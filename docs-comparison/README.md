# Docs Comparison: Solarcido vs Claw-Rust

This folder contains side-by-side documentation of key files from Solarcido (TypeScript) and Claw-Rust (Rust). Each file is analyzed individually, with Solarcido implementation described first, followed by Claw-Rust implementation details.

Structure:
- Each file is documented in its own Markdown file (e.g., `planner.md`).
- The analysis follows a "read one, write one" pattern: after reading a Solarcido file, we write its comparison.
- The goal is to highlight differences in architecture, language, tooling, and design patterns.

## Files Covered

- `planner.md`
- `executor.md`
- `explorer.md`
- `verifier.md`
- `reviewer.md`
- `solar/client.md`
- `solar/constants.md`
- `solar/client.js` (Solarcido) vs `runtime/src/client.rs` (Claw-Rust)
- `tools/registry.md`
- `workflow/agent-loop.md`
- `workflow/orchestrator.md`
- `commands/lib.rs` (slash command handling)
- `api/src/client.rs` (API client)
- `commands/src/lib.rs` (agents slash command)

## How to Use

1. Read the Solarcido file.
2. Write the comparison markdown file.
3. Clear context (i.e., move on to the next file).

---

**Note:** This is a work-in-progress. Files will be added as they are analyzed.