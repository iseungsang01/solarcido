// Bootstrap phase enumeration and planning for Solarcido.
// Ported from claw-rust/crates/runtime/src/bootstrap.rs.
// Pure module: no I/O, no side effects.

// ---------------------------------------------------------------------------
// BootstrapPhase
// ---------------------------------------------------------------------------

/**
 * Named startup phases executed in order during CLI initialisation.
 *
 * Variants map 1-to-1 to the Rust BootstrapPhase enum so cross-language
 * parity is easy to verify.
 */
export type BootstrapPhase =
  | "cli-entry"
  | "fast-path-version"
  | "startup-profiler"
  | "system-prompt-fast-path"
  | "chrome-mcp-fast-path"
  | "daemon-worker-fast-path"
  | "bridge-fast-path"
  | "daemon-fast-path"
  | "background-session-fast-path"
  | "template-fast-path"
  | "environment-runner-fast-path"
  | "main-runtime";

// ---------------------------------------------------------------------------
// BootstrapPlan
// ---------------------------------------------------------------------------

/**
 * An ordered, deduplicated list of BootstrapPhases to execute.
 *
 * Deduplication preserves first-occurrence order, identical to the Rust
 * `BootstrapPlan::from_phases` behaviour.
 */
export type BootstrapPlan = {
  readonly phases: readonly BootstrapPhase[];
};

/**
 * Build a BootstrapPlan from an arbitrary phase list, deduplicating while
 * preserving first-occurrence order.
 */
export function bootstrapPlanFromPhases(phases: readonly BootstrapPhase[]): BootstrapPlan {
  const seen = new Set<BootstrapPhase>();
  const deduped: BootstrapPhase[] = [];
  for (const phase of phases) {
    if (!seen.has(phase)) {
      seen.add(phase);
      deduped.push(phase);
    }
  }
  return { phases: deduped };
}

/**
 * The default Solarcido bootstrap plan — all phases in canonical order.
 *
 * Mirrors `BootstrapPlan::claude_code_default` from the Rust port (renamed to
 * reflect this project's identity).
 */
export function solarcidoDefaultBootstrapPlan(): BootstrapPlan {
  return bootstrapPlanFromPhases([
    "cli-entry",
    "fast-path-version",
    "startup-profiler",
    "system-prompt-fast-path",
    "chrome-mcp-fast-path",
    "daemon-worker-fast-path",
    "bridge-fast-path",
    "daemon-fast-path",
    "background-session-fast-path",
    "template-fast-path",
    "environment-runner-fast-path",
    "main-runtime",
  ]);
}
