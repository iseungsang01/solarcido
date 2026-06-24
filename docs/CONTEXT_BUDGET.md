# Context Budget & Compaction — Decision Record

Status: all of P0–P3 implemented and tested (`npm run typecheck` clean; full
suite green). Tunable constants and follow-ups at the bottom.

## Problem

Solarcido runs on `solar-pro3-260323`, whose context window is **~1/8–1/10 of what
Claude Code runs with**. The context-management machinery (token estimation,
compaction, error handling) was ported from `claw-rust` and tuned for a much
larger, Claude-shaped window. On the smaller real window, the gap shows up not as
gradual quality loss but as **abrupt hard failures**: the request crosses the
provider limit before any safety valve fires, and the resulting error is not
recovered.

## Measurements (live API, 2026-06)

Probed directly against `https://api.upstage.ai/v1` (scripts were throwaway; not
committed):

| What | Result |
|---|---|
| Context window | **Exactly 131,072 tokens.** Server: *"maximum context length is 131072 tokens, but your request contains 140020 tokens"* (`code: context_length_exceeded`). The registry value in `provider-registry.ts` is correct. |
| Output cap | `max_tokens` honored exactly (`4096→4096`, `8192→8192`, both `finish_reason=length`). **>4096 is allowed.** |
| Default (no `max_tokens`) | Streamed ~18 MB before a duration/socket cutoff — i.e. no small default cap; output shares the 131,072-token pool with input. |
| Tokenizer ratio | Plain ASCII ≈ **5 chars/token** (`16,000 chars → 3,275 tokens`). So `chars/4` over-counts ASCII ~25% (safe). Korean/CJK is far denser (~1.7 chars/token); a uniform `chars/4` under-counts Korean ~2× (dangerous). |

The "1/10" is therefore **relative to Claude Code's ~1M window**, not an absolute
~13K window. The absolute window is a healthy 128K; the bugs are in how that
budget is accounted for and protected.

## Issues & severity

| # | Issue | Location | Severity |
|---|---|---|---|
| 3 | Single tool result can exceed the whole window — `read_file` returns ≤1 MB, `run_command` buffers ≤4 MB, no truncation | `file-ops.ts`, `bash.ts` | Critical |
| 2 | Token estimate counts only the side-channel `transcript` (omits system prompt, tool schemas, **tool-call argument bodies**) and treats all chars as `/4` (under-counts Korean) | `conversation.ts`, `context-budget.ts` | Critical |
| 1b | On a context-window overflow the error is *classified* but not recovered — session just fails | `conversation.ts` error path | High |
| 4 | Compaction drops the most recent work: `safeRecentMessages` breaks at the first tool boundary, so `recent` is usually empty | `conversation.ts` | High |
| 5 | Summary gated to once per 3 turns and pre-truncated to 8000 chars; off-cadence compaction loses the middle to a one-line notice | `conversation.ts` | Medium |
| 6 | `messages` grows monotonically between compactions; thin headroom vs `maxTurns=20` | `conversation.ts` | Medium |
| 7 | `max_tokens` never sent → registry `maxOutputTokens: 4096` is dead config; no guard against runaway output sharing the pool | `openai-compatible.ts` | Low |

> Retracted from the first draft: "the compaction threshold is set above the real
> ceiling." The window is genuinely 128K, so the 90% threshold sat *below* the
> ceiling. The real defect is #2 eating the thin (~13K) headroom.

## Decisions

### P0-1 — Cap every tool result (issue #3) — DONE
New `src/runtime/output-limits.ts` exports `clampText(text, maxChars, mode, hint)`
and three caps. Wired into:
- `bash.ts` `formatCommandOutput` — stdout/stderr each clamped `head-tail` (errors
  surface at the tail) to `MAX_COMMAND_STREAM_CHARS` (16,000).
- `file-ops.ts` `readFile` (regular + PDF) clamped `head` to `MAX_READ_OUTPUT_CHARS`
  (100,000); `searchFiles` clamped to `MAX_SEARCH_OUTPUT_CHARS` (40,000).
Limits are in characters so truncation never splits a multi-byte code point.

### P0-2 — Account for the real payload (issue #2) — DONE
- `context-budget.ts`: `estimateTokens` is now CJK-aware (ASCII `/4`, CJK `×0.6`
  tokens/char). New `estimateMessageTokens` / `estimateMessagesTokens` count text
  content **and** every tool-call name + arguments JSON + envelope.
- `conversation.ts`: compaction gates on
  `estimateMessagesTokens(messages) + toolsTokens` (tool schemas counted once,
  computed once before the loop) instead of the transcript array. Budget is now
  **model-aware**: `resolveTranscriptBudget(model)` = explicit override, else the
  model's `contextWindowTokens` − `RESERVED_OUTPUT_TOKENS` (16,384) so a full
  transcript still leaves room to reply. Added an early return when there is
  nothing droppable.

Verified: `npm run typecheck` clean; full suite green; new
`tests/context-limits.test.mjs` (registered in `package.json`).

### P1-1 — Recover from overflow (issue #1b) — DONE
In `runTurn`, the per-turn completion is wrapped: a classified `context-window`
error triggers one out-of-band forced compaction (`budget = 0`) and a single
retry; if compaction sheds nothing, the original error is surfaced. Reactive
safety net beneath P3's preventive cap.

### P1-2 — Preserve recent work on compaction (issue #4) — DONE
`safeRecentMessages` was rewritten: it returns the trailing `limit` messages with
any leading orphan `tool` result trimmed, instead of stopping at the first tool
boundary (which collapsed to empty whenever the transcript ended on a tool
result — the usual case — discarding the most recent work). The trailing-window
size is the new `compactionRecentMessages` option (default `DEFAULT_COMPACTION_RECENT`
= 12; `0` = summarize everything). Exported and unit-tested.

### P2-1 — Don't lose the dropped middle off-cadence (issue #5) — DONE
On the off-cadence path (no paid model summary) compaction now falls back to the
extractive `compressSummary` of the dropped segment instead of a bare notice. The
summary input is rendered with a compact note of each dropped tool call (name +
truncated args) and the pre-truncation was raised 8,000 → 24,000 chars. The bare
notice remains only as a last resort (cadence met but the model summary failed).

### P2-2 — Reserve output space (issue #6) — DONE
Covered by `RESERVED_OUTPUT_TOKENS` (budget = context window − reserve) plus P3's
per-request cap.

### P3 — Bound output without truncating legitimate work (issue #7) — DONE
Measurements showed there is no harmful small default cap, so a *fixed*
`max_tokens` would have done more harm than good (truncated large `write_file`
tool calls; spurious 400s near a full window). Instead the runtime sends a
**context-aware** `max_tokens` per request:
`clamp(256, min(maxTokensForModel(model), contextWindow − inputTokens − 512))`.
When the window is mostly empty this is the model's ceiling (no truncation of
normal work); as input grows it shrinks so input+output can never overflow.
`ChatRunOptions.maxTokens` was added and wired through `openai-compatible.ts`;
the dead-but-misleading registry value `solar-pro3 maxOutputTokens` was corrected
`4096 → 16384`.

## Live validation (against the real Solar API)

Ran the built runtime end-to-end against `api.upstage.ai` (throwaway scripts):

- **Tool caps (P0-1):** a 300K-char file read returned ~100K chars with a
  truncation marker; 60K chars of command stdout returned ~16K. PASS.
- **Compaction across turns (P0-2/P1-2/P2-1):** a low-budget multi-turn run
  fired a real summary, sent the compacted messages back to the API without
  error, and completed via `finish`. PASS.
- **Overflow recovery (P1-1):** an ~800K-char resume message produced a real
  `context_length_exceeded` (firstErrKind=`context-window`); the runtime forced a
  compaction, retried, and continued instead of dying. PASS.

**Bug found & fixed during validation:** the P1-1 recovery guard originally
checked `messages.length` to decide whether compaction shed anything. Compaction
replaces the dropped middle with a single summary message, so dropping one huge
message leaves the count unchanged (e.g. 4 → 4) — the guard wrongly concluded
"nothing shed" and re-threw. Changed to compare `estimateMessagesTokens` before/
after. The unit test now uses a single huge droppable message to lock this in.

> Caveat: in the synthetic recovery test the model did not call `finish` within
> the turn cap (it kept making valid calls). That is model nondeterminism in an
> artificial transcript, not a recovery-path defect — the contract (don't die,
> shed tokens, retry, continue) held.

## Follow-ups (not done)

- Revisit `RESERVED_OUTPUT_TOKENS` / the budget fraction with real long-run usage data.
- Consider provider `prompt_tokens` from the previous response as a calibration
  signal for the estimator (the API reports it; `cached_tokens` too).

## Tunable constants

| Constant | Value | File |
|---|---|---|
| `MAX_COMMAND_STREAM_CHARS` | 16,000 | `runtime/output-limits.ts` |
| `MAX_READ_OUTPUT_CHARS` | 100,000 | `runtime/output-limits.ts` |
| `MAX_SEARCH_OUTPUT_CHARS` | 40,000 | `runtime/output-limits.ts` |
| `RESERVED_OUTPUT_TOKENS` | 16,384 | `runtime/conversation.ts` |
| `DEFAULT_COMPACTION_RECENT` | 12 | `runtime/conversation.ts` |
| `MIN_TURNS_BETWEEN_SUMMARIES` | 3 | `runtime/conversation.ts` |
| `contextWindowTokens` (solar-pro3) | 131,072 | `api/provider-registry.ts` |
| `maxOutputTokens` (solar-pro3) | 16,384 | `api/provider-registry.ts` |

## Tests

- `tests/context-limits.test.mjs` — `clampText`, CJK-aware `estimateTokens`, tool-call accounting.
- `tests/conversation.test.mjs` — `safeRecentMessages` group preservation; context-window overflow recovery; existing compaction tests pinned with `compactionRecentMessages: 0`.
