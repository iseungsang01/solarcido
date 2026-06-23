// TaskPacket: typed envelope for agent task dispatch.
// Ported from claw-rust/crates/runtime/src/task_packet.rs.
// Pure module: no filesystem I/O, no side effects.

// ---------------------------------------------------------------------------
// TaskScope
// ---------------------------------------------------------------------------

/** Granularity of work a task covers. */
export type TaskScope =
  | { kind: "workspace" }
  | { kind: "module" }
  | { kind: "single-file" }
  | { kind: "custom" };

/** Convenience constants matching the Rust enum variants. */
export const TaskScope = {
  Workspace: { kind: "workspace" } as TaskScope,
  Module: { kind: "module" } as TaskScope,
  SingleFile: { kind: "single-file" } as TaskScope,
  Custom: { kind: "custom" } as TaskScope,
} as const;

/** Return the string label for a scope (used in error messages and display). */
export function taskScopeLabel(scope: TaskScope): string {
  return scope.kind;
}

// ---------------------------------------------------------------------------
// TaskPacket
// ---------------------------------------------------------------------------

/** Structured brief handed to a sub-agent when creating a scoped task. */
export type TaskPacket = {
  objective: string;
  scope: TaskScope;
  /** Required when scope is module, single-file, or custom. */
  scopePath?: string;
  repo: string;
  /** Worktree path for the task, if the orchestrator prepared one. */
  worktree?: string;
  branchPolicy: string;
  acceptanceTests: string[];
  commitPolicy: string;
  reportingContract: string;
  escalationPolicy: string;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validation failure carrying one or more field-level error messages. */
export class TaskPacketValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "TaskPacketValidationError";
    this.errors = errors;
  }
}

/**
 * Newtype wrapper produced by validatePacket on success.
 * Having a ValidatedPacket in hand means the packet passed all field checks.
 */
export class ValidatedPacket {
  readonly #inner: TaskPacket;

  /** @internal — use validatePacket() to create instances. */
  constructor(packet: TaskPacket) {
    this.#inner = packet;
  }

  /** Return a reference to the underlying packet. */
  packet(): TaskPacket {
    return this.#inner;
  }

  /** Consume the wrapper and return the underlying packet. */
  intoInner(): TaskPacket {
    return this.#inner;
  }
}

function validateRequired(field: string, value: string, errors: string[]): void {
  if (value.trim() === "") {
    errors.push(`${field} must not be empty`);
  }
}

function validateScopeRequirements(packet: TaskPacket, errors: string[]): void {
  const needsScopePath =
    packet.scope.kind === "module" ||
    packet.scope.kind === "single-file" ||
    packet.scope.kind === "custom";

  if (needsScopePath && (packet.scopePath === undefined || packet.scopePath.trim() === "")) {
    errors.push(`scope_path is required for scope '${taskScopeLabel(packet.scope)}'`);
  }
}

/**
 * Validate a TaskPacket, returning a ValidatedPacket on success or a
 * TaskPacketValidationError accumulating all field errors on failure.
 */
export function validatePacket(packet: TaskPacket): ValidatedPacket {
  const errors: string[] = [];

  validateRequired("objective", packet.objective, errors);
  validateRequired("repo", packet.repo, errors);
  validateRequired("branch_policy", packet.branchPolicy, errors);
  validateRequired("commit_policy", packet.commitPolicy, errors);
  validateRequired("reporting_contract", packet.reportingContract, errors);
  validateRequired("escalation_policy", packet.escalationPolicy, errors);

  validateScopeRequirements(packet, errors);

  packet.acceptanceTests.forEach((test, index) => {
    if (test.trim() === "") {
      errors.push(`acceptance_tests contains an empty value at index ${index}`);
    }
  });

  if (errors.length > 0) {
    throw new TaskPacketValidationError(errors);
  }

  return new ValidatedPacket(packet);
}
