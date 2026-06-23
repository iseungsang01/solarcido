// In-memory registries for Team and Cron lifecycle management.
// Ported from claw-rust/crates/runtime/src/team_cron_registry.rs.
// Deterministic: IDs and timestamps are injected via IdClock for testability.

// ---------------------------------------------------------------------------
// Shared clock injection
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

let _defaultTeamCounter = 0;
let _defaultCronCounter = 0;

function makeTeamClock(): IdClock {
  return {
    nextId: () => ++_defaultTeamCounter,
    nowSecs: () => Math.floor(Date.now() / 1000),
  };
}

function makeCronClock(): IdClock {
  return {
    nextId: () => ++_defaultCronCounter,
    nowSecs: () => Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// TeamStatus
// ---------------------------------------------------------------------------

/** Lifecycle state of a team. */
export type TeamStatus = "created" | "running" | "completed" | "deleted";

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** A team record grouping related tasks under a named coordinator. */
export type Team = {
  teamId: string;
  name: string;
  taskIds: string[];
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// TeamRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory registry for team lifecycle management.
 *
 * Delete is a soft-delete (status → "deleted"); remove() is the hard delete.
 */
export class TeamRegistry {
  readonly #teams = new Map<string, Team>();
  readonly #clock: IdClock;

  constructor(clock?: IdClock) {
    this.#clock = clock ?? makeTeamClock();
  }

  // -- Creation ---------------------------------------------------------------

  /** Create a new team with an initial list of task IDs. */
  create(name: string, taskIds: string[]): Team {
    const ts = this.#clock.nowSecs();
    const n = this.#clock.nextId();
    const teamId = `team_${ts.toString(16).padStart(8, "0")}_${n}`;
    const team: Team = {
      teamId,
      name,
      taskIds: [...taskIds],
      status: "created",
      createdAt: ts,
      updatedAt: ts,
    };
    this.#teams.set(teamId, team);
    return { ...team, taskIds: [...team.taskIds] };
  }

  // -- Reads ------------------------------------------------------------------

  /** Return a shallow copy of the team, or undefined when not found. */
  get(teamId: string): Team | undefined {
    const t = this.#teams.get(teamId);
    return t ? { ...t, taskIds: [...t.taskIds] } : undefined;
  }

  /** List all teams (including soft-deleted). */
  list(): Team[] {
    return Array.from(this.#teams.values()).map((t) => ({ ...t, taskIds: [...t.taskIds] }));
  }

  get size(): number {
    return this.#teams.size;
  }

  get isEmpty(): boolean {
    return this.#teams.size === 0;
  }

  // -- Soft delete ------------------------------------------------------------

  /**
   * Mark a team as deleted (soft delete — the record remains in the registry).
   *
   * @throws Error when team is not found.
   * @returns a copy of the updated team.
   */
  delete(teamId: string): Team {
    const team = this.#require(teamId);
    team.status = "deleted";
    team.updatedAt = this.#clock.nowSecs();
    return { ...team, taskIds: [...team.taskIds] };
  }

  // -- Hard removal -----------------------------------------------------------

  /** Remove a team from the registry entirely. Returns the removed team or undefined. */
  remove(teamId: string): Team | undefined {
    const t = this.#teams.get(teamId);
    if (t === undefined) return undefined;
    this.#teams.delete(teamId);
    return { ...t, taskIds: [...t.taskIds] };
  }

  // ---------------------------------------------------------------------------

  #require(teamId: string): Team {
    const t = this.#teams.get(teamId);
    if (t === undefined) throw new Error(`team not found: ${teamId}`);
    return t;
  }
}

// ---------------------------------------------------------------------------
// CronEntry
// ---------------------------------------------------------------------------

/** A scheduled recurring action. */
export type CronEntry = {
  cronId: string;
  schedule: string;
  prompt: string;
  description?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
};

// ---------------------------------------------------------------------------
// CronRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory registry for cron lifecycle management.
 *
 * Delete is a hard delete (record is removed). Use disable() to stop a cron
 * without removing it.
 */
export class CronRegistry {
  readonly #entries = new Map<string, CronEntry>();
  readonly #clock: IdClock;

  constructor(clock?: IdClock) {
    this.#clock = clock ?? makeCronClock();
  }

  // -- Creation ---------------------------------------------------------------

  /** Create a new enabled cron entry. */
  create(schedule: string, prompt: string, description?: string): CronEntry {
    const ts = this.#clock.nowSecs();
    const n = this.#clock.nextId();
    const cronId = `cron_${ts.toString(16).padStart(8, "0")}_${n}`;
    const entry: CronEntry = {
      cronId,
      schedule,
      prompt,
      description,
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
      lastRunAt: undefined,
      runCount: 0,
    };
    this.#entries.set(cronId, entry);
    return { ...entry };
  }

  // -- Reads ------------------------------------------------------------------

  /** Return a shallow copy of the cron entry, or undefined when not found. */
  get(cronId: string): CronEntry | undefined {
    const e = this.#entries.get(cronId);
    return e ? { ...e } : undefined;
  }

  /**
   * List cron entries.
   * @param enabledOnly when true, only enabled entries are returned.
   */
  list(enabledOnly: boolean): CronEntry[] {
    const results: CronEntry[] = [];
    for (const e of this.#entries.values()) {
      if (!enabledOnly || e.enabled) {
        results.push({ ...e });
      }
    }
    return results;
  }

  get size(): number {
    return this.#entries.size;
  }

  get isEmpty(): boolean {
    return this.#entries.size === 0;
  }

  // -- Mutations --------------------------------------------------------------

  /**
   * Disable a cron entry without removing it.
   *
   * @throws Error when cron entry is not found.
   */
  disable(cronId: string): void {
    const entry = this.#require(cronId);
    entry.enabled = false;
    entry.updatedAt = this.#clock.nowSecs();
  }

  /**
   * Record a successful cron execution, incrementing run_count and updating
   * last_run_at.
   *
   * @throws Error when cron entry is not found.
   */
  recordRun(cronId: string): void {
    const entry = this.#require(cronId);
    const ts = this.#clock.nowSecs();
    entry.lastRunAt = ts;
    entry.runCount += 1;
    entry.updatedAt = ts;
  }

  // -- Removal ----------------------------------------------------------------

  /**
   * Hard-delete a cron entry.
   *
   * @throws Error when cron entry is not found.
   * @returns the removed entry.
   */
  delete(cronId: string): CronEntry {
    const e = this.#entries.get(cronId);
    if (e === undefined) throw new Error(`cron not found: ${cronId}`);
    this.#entries.delete(cronId);
    return { ...e };
  }

  // ---------------------------------------------------------------------------

  #require(cronId: string): CronEntry {
    const e = this.#entries.get(cronId);
    if (e === undefined) throw new Error(`cron not found: ${cronId}`);
    return e;
  }
}
