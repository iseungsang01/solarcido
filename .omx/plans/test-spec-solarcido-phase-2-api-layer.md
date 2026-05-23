# Test Spec: Solarcido Phase 2 API Layer

## Required Verification
1. 
pm run typecheck
2. 
pm test
3. 
pm run build

## Focus Checks
- Type imports compile after replacing solar API references.
- Tests that exercise CLI/config/tool/runtime paths still pass.
- Build emits from source without direct dist edits.

## Regression Risks
- OpenAI SDK types leaking into runtime despite ApiClient abstraction.
- Default model/base URL drift from prior src/solar/constants.ts behavior.
- Accidental edits outside Phase 2 scope.
