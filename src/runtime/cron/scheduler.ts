// Cron scheduler — pure functions for determining which jobs are due at a
// given moment and for validating a set of cron jobs.
//
// All logic is deterministic; callers supply the Date. Timezone basis: UTC
// (delegated to cronMatches in expression.ts which uses getUTC* methods).

import { cronMatches, parseCronExpression } from "./expression.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A named, scheduled recurring goal. */
export type CronJob = {
  name: string;
  schedule: string;
  goal: string;
};

/** A job that failed schedule validation. */
export type CronJobError = {
  name: string;
  error: string;
};

/** Result of validating a collection of CronJobs. */
export type ValidationResult = {
  ok: CronJob[];
  errors: CronJobError[];
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Return the subset of `jobs` whose cron schedule matches `at` (UTC,
 * minute granularity).
 *
 * Jobs with an invalid schedule string are silently skipped (use
 * `validateCronJobs` first if you want to surface parse errors).
 */
export function dueJobs(jobs: CronJob[], at: Date): CronJob[] {
  const due: CronJob[] = [];
  for (const job of jobs) {
    try {
      if (cronMatches(job.schedule, at)) {
        due.push(job);
      }
    } catch {
      // invalid schedule — not due
    }
  }
  return due;
}

/**
 * Partition `jobs` into those with a valid schedule (`ok`) and those whose
 * schedule string fails to parse (`errors`).
 */
export function validateCronJobs(jobs: CronJob[]): ValidationResult {
  const ok: CronJob[] = [];
  const errors: CronJobError[] = [];
  for (const job of jobs) {
    try {
      parseCronExpression(job.schedule);
      ok.push(job);
    } catch (e) {
      errors.push({ name: job.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, errors };
}

// ---------------------------------------------------------------------------
// Optional class wrapper
// ---------------------------------------------------------------------------

/**
 * Thin stateless class wrapping the pure functions above.
 * Useful when callers prefer an object-oriented API.
 */
export class CronScheduler {
  /** @see dueJobs */
  dueJobs(jobs: CronJob[], at: Date): CronJob[] {
    return dueJobs(jobs, at);
  }

  /** @see validateCronJobs */
  validateCronJobs(jobs: CronJob[]): ValidationResult {
    return validateCronJobs(jobs);
  }
}
