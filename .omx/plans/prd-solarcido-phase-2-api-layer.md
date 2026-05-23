# PRD: Solarcido Phase 2 API Layer

## Objective
Move the Solarcido model API boundary from src/solar to src/api while preserving behavior.

## Scope
- Add an ApiClient interface and chat options types under src/api.
- Move Upstage/OpenAI-compatible client construction into src/api/providers/upstage.ts.
- Provide a stable src/api/client.ts entrypoint for runtime callers.
- Update runtime/agent imports away from src/solar.

## Non-goals
- Do not implement MCP, plugins, workers, OAuth, gateway, or broader runtime refactors.
- Do not intentionally change CLI behavior or model request semantics.

## Acceptance Criteria
- Existing code uses src/api for model client imports.
- API provider constants remain available and equivalent.
- 
pm run typecheck, 
pm test, and 
pm run build are run and pass, or any failure is explicitly tied to a pre-existing unrelated blocker with evidence.
