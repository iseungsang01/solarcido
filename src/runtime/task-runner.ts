/**
 * Drives tasks from a {@link TaskRegistry} to completion through an injected
 * executor, updating lifecycle status + output along the way. This is the
 * execution layer that connects the (otherwise inert) task/team registries to
 * real work: a TaskExecutor that runs a goal through the conversation loop turns
 * this into team execution, while keeping the runner itself testable with a
 * mock executor.
 */
import type { Task, TaskRegistry } from "./task-registry.js";

export type TaskExecution = { ok: boolean; output: string };

/** Runs a single task's work (e.g. a goal through the agent loop). */
export type TaskExecutor = (task: Task) => Promise<TaskExecution>;

export type RunTasksOptions = {
  /** Max tasks to run concurrently (default 1 = sequential). */
  concurrency?: number;
};

export class TaskRunner {
  constructor(
    private readonly registry: TaskRegistry,
    private readonly executor: TaskExecutor,
  ) {}

  /** Run one task by id, recording its output and terminal status. */
  async runTask(taskId: string): Promise<Task> {
    this.registry.setStatus(taskId, "running");
    const task = this.requireTask(taskId);
    try {
      const result = await this.executor(task);
      this.registry.appendOutput(taskId, result.output);
      this.registry.setStatus(taskId, result.ok ? "completed" : "failed");
    } catch (error) {
      this.registry.appendOutput(taskId, `ERROR: ${error instanceof Error ? error.message : String(error)}`);
      this.registry.setStatus(taskId, "failed");
    }
    return this.requireTask(taskId);
  }

  /** Run every `created` task, in batches of `concurrency`. */
  async runPending(options: RunTasksOptions = {}): Promise<Task[]> {
    return this.runBatch(this.registry.list("created").map((task) => task.taskId), options);
  }

  /** Run a specific set of task ids (e.g. the members of a team). */
  async runBatch(taskIds: string[], options: RunTasksOptions = {}): Promise<Task[]> {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    const results: Task[] = [];
    for (let index = 0; index < taskIds.length; index += concurrency) {
      const slice = taskIds.slice(index, index + concurrency);
      results.push(...(await Promise.all(slice.map((id) => this.runTask(id)))));
    }
    return results;
  }

  private requireTask(taskId: string): Task {
    const task = this.registry.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    return task;
  }
}
