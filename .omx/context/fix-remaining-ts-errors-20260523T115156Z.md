# Context Snapshot: Fix Remaining TypeScript Errors

## Task statement
Fix remaining TypeScript type and import errors exposed after fixing `src/workflow/agent-loop.ts`, then run `npm run typecheck`, `npm test`, and `npm run build`.

## Desired outcome
TypeScript typecheck, tests, and build pass without starting Phase 2 architecture migration.

## Known facts/evidence
Syntax errors in `src/workflow/agent-loop.ts` were fixed. Current errors are type/import mismatches across `src/agents/*`, `src/workflow/*`, and typed option plumbing.

## Constraints
- Keep changes focused on making current architecture compile/test.
- Do not begin Phase 2 API layer migration.
- Do not delete existing files.
- Preserve runtime behavior where possible.

## Unknowns/open questions
- Whether transitional orchestrator/agents are intended to compile as currently wired or need compatibility shims.

## Likely codebase touchpoints
- `src/agents/*`
- `src/workflow/*`
- possibly shared types/constants for approval and sandbox modes