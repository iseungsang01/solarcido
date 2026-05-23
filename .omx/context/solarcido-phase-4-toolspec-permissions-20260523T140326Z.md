# Ralph Context Snapshot: Phase 4 ToolSpec Permission Metadata

## Task statement
Implement Phase 4 from `.omx/plans/ralplan-solarcido-claw-rust-port.md`.

## Desired outcome
Solarcido tools use a `ToolSpec` model with first-class `requiredPermission` metadata. Tool definitions can be filtered by maximum permission mode, and execution enforces the same permission rules even if a hidden/disallowed tool is called.

## Known facts/evidence
- Plan file defines Phase 4 objective and required types.
- Phase 2 and Phase 3 are marked complete in the plan.
- Current working tree contains prior phase changes; preserve them.
- `docs/shared/agent-tiers.md` is not present in this repository.

## Constraints
- Do not modify generated `dist/` directly.
- Keep CLI behavior stable.
- Update tests for observable tool permission behavior.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `node dist/index.js --help` after changes.

## Unknowns/open questions
- Exact current shape of `src/tools/registry.ts` and sandbox permission types must be inspected before editing.
- Existing tests may already partially cover permission enforcement.

## Likely codebase touchpoints
- `src/runtime/permissions.ts`
- `src/tools/specs.ts`
- `src/tools/registry.ts`
- `src/workflow/run-agent-loop.ts` or callers of `createToolDefinitions`
- `tests/tools.test.mjs`