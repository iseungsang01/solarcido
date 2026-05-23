# Ralph Context Snapshot: Solarcido Phase 2 API Layer

- task statement: Implement Phase 2 from .omx/plans/ralplan-solarcido-claw-rust-port.md, then run 
pm run typecheck, 
pm test, and 
pm run build.
- desired outcome: src/solar is no longer the conceptual API boundary; API client surface lives under src/api, existing behavior remains equivalent, and requested verification commands are run/read.
- known facts/evidence: Phase 0/1 plan is completed; Phase 2 objective is to move Upstage/OpenAI-compatible client creation into src/api/providers/upstage.ts, introduce an ApiClient interface, and update imports from solar to pi. Current git status has prior Phase 0/1 edits and pre-existing modified workflow/agent files.
- constraints: preserve user changes; do not edit dist directly; check docs/SPEC before API/config/tool behavior changes; keep scope to Phase 2; no MCP/plugins/workers; use TypeScript strict style; run requested verification. Ralph gate requires PRD and test-spec artifacts before implementation.
- unknowns/open questions: whether pre-existing src/workflow/agent-loop.ts syntax errors still block verification; resolve by inspecting and fixing only if necessary for Phase 2 exit criteria.
- likely codebase touchpoints: src/solar/client.ts, src/solar/constants.ts, src/api/types.ts, src/api/client.ts, src/api/providers/upstage.ts, imports in src/workflow/*, src/agents/*, src/cli.ts, src/interactive.ts, tests if API imports are covered.
