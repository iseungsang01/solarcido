// In-memory task registry for sub-agent task lifecycle management.
// Ported from claw-rust/crates/runtime/src/task_registry.rs.
// Deterministic: no Date.now() / Math.random() in module code.
// IDs and timestamps are injected via IdClock for testability.

import { validatePacket, TaskPacket, TaskPacketValidationError } from "./task-packet.js";

// ---------------------------------------------------------------------------
// TaskStatus
// ---------------------------------------------------------------------------

/** Lifecycle state of a task. Terminal states: Completed, Failed, Stopped. */
export type TaskStatus = "created" | "running" | "completed" | "failed" | "stopped";

/** True when a task has reached a terminal state and cannot be transitioned further. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

// ---------------------------------------------------------------------------
// Task + TaskMessage
// ---------------------------------------------------------------------------

/** A message appended to a task's conversation log. */
export type TaskMessage = {
  role: string;
  content: string;
  timestamp: number;
};

/** A task record stored in the registry. */
export type Task = {
  taskId: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  messages: TaskMessage[];
  output: string;
  teamId?: string;
};

// ---------------------------------------------------------------------------
// Clock injection
// ---------------------------------------------------------------------------

/**
 * Injectable clock/id source for deterministic testing.
 * The default implementation uses a monotonic counter for IDs and Date.now()
 * for timestamps.
 */
export type IdClock = {
  nextId: () => number;
  nowSecs: () => number;
};

let _defaultCounter = 0;

function makeDefaultClock(): IdClock {
  return {
    nextId: () => ++_defaultCounter,
    nowSecs: () => Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// TaskRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory registry for task lifecycle management.
 *
 * Accepts an optional IdClock so tests can inject deterministic ids and
 * timestamps without patching globals.
 */
export class TaskRegistry {
  readonly #tasks = new Map<string, Task>();
  readonly #clock: IdClock;

  constructor(clock?: IdClock) {
    this.#clock = clock ?? makeDefaultClock();
  }

  // -- Creation ---------------------------------------------------------------

  /** Create a task from a raw prompt string and optional description. */
  create(prompt: string, description?: string): Task {
    return this.#createTask(prompt, description, undefined);
  }

  /**
   * Validate packet and create a task from it.
   * The packet's objective becomes the prompt; scope_path (or scope label) becomes
   * the description.
   *
   * @throws TaskPacketValidationError when the packet fails validation.
   */
  createFromPacket(packet: TaskPacket): Task {
    const validated = validatePacket(packet); // throws on failure
    const inner = validated.intoInner();
    const description = inner.scopePath ?? inner.scope.kind;
    return this.#createTask(inner.objective, description, inner);
  }

  #createTask(prompt: string, description: string | undefined, taskPacket: TaskPacket | undefined): Task {
    const ts = this.#clock.nowSecs();
    const n = this.#clock.nextId();
    const taskId = `task_${ts.toString(16).padStart(8, "0")}_${n}`;
    const task: Task = {
      taskId,
      prompt,
      description,
      taskPacket,
      status: "created",
      createdAt: ts,
      updatedAt: ts,
      messages: [],
      output: "",
      teamId: undefined,
    };
    this.#tasks.set(taskId, task);
    return { ...task };
  }

  // -- Reads ------------------------------------------------------------------

  /** Return a shallow copy of the task, or undefined when not found. */
  get(taskId: string): Task | undefined {
    const t = this.#tasks.get(taskId);
    return t ? { ...t, messages: [...t.messages] } : undefined;
  }

  /** List all tasks, optionally filtered by status. */
  list(statusFilter?: TaskStatus): Task[] {
    const results: Task[] = [];
    for (const t of this.#tasks.values()) {
      if (statusFilter === undefined || t.status === statusFilter) {
        results.push({ ...t, messages: [...t.messages] });
      }
    }
    return results;
  }

  get size(): number {
    return this.#tasks.size;
  }

  get isEmpty(): boolean {
    return this.#tasks.size === 0;
  }

  // -- Status transitions -----------------------------------------------------

  /**
   * Set a task's status directly.
   *
   * @throws string error message when task is not found.
   */
  setStatus(taskId: string, status: TaskStatus): void {
    const task = this.#require(taskId);
    task.status = status;
    task.updatedAt = this.#clock.nowSecs();
  }

  /**
   * Transition a task to Stopped.
   * Rejects tasks already in a terminal state.
   *
   * @throws string error message on failure.
   * @returns a copy of the updated task.
   */
  stop(taskId: string): Task {
    const task = this.#require(taskId);
    if (isTerminalStatus(task.status)) {
      throw new Error(`task ${taskId} is already in terminal state: ${task.status}`);
    }
    task.status = "stopped";
    task.updatedAt = this.#clock.nowSecs();
    return { ...task, messages: [...task.messages] };
  }

  // -- Messages and output ----------------------------------------------------

  /**
   * Append a user message to the task's conversation log.
   *
   * @throws string error message when task is not found.
   * @returns a copy of the updated task.
   */
  update(taskId: string, message: string): Task {
    const task = this.#require(taskId);
    task.messages.push({ role: "user", content: message, timestamp: this.#clock.nowSecs() });
    task.updatedAt = this.#clock.nowSecs();
    return { ...task, messages: [...task.messages] };
  }

  /**
   * Append a string fragment to the task's accumulated output.
   *
   * @throws string error message when task is not found.
   */
  appendOutput(taskId: string, output: string): void {
    const task = this.#require(taskId);
    task.output += output;
    task.updatedAt = this.#clock.nowSecs();
  }

  /**
   * Return the full accumulated output for a task.
   *
   * @throws string error message when task is not found.
   */
  output(taskId: string): string {
    return this.#require(taskId).output;
  }

  // -- Team assignment --------------------------------------------------------

  /**
   * Associate a task with a team.
   *
   * @throws string error message when task is not found.
   */
  assignTeam(taskId: string, teamId: string): void {
    const task = this.#require(taskId);
    task.teamId = teamId;
    task.updatedAt = this.#clock.nowSecs();
  }

  // -- Removal ----------------------------------------------------------------

  /** Hard-remove a task from the registry. Returns the removed task or undefined. */
  remove(taskId: string): Task | undefined {
    const t = this.#tasks.get(taskId);
    if (t === undefined) return undefined;
    this.#tasks.delete(taskId);
    return { ...t, messages: [...t.messages] };
  }

  // ---------------------------------------------------------------------------

  #require(taskId: string): Task {
    const t = this.#tasks.get(taskId);
    if (t === undefined) throw new Error(`task not found: ${taskId}`);
    return t;
  }
}
