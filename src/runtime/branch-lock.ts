/**
 * Branch-lock collision detection — pure functions over structured input data,
 * no git calls needed. Ported provider-neutral from
 * claw-rust crates/runtime/src/branch_lock.rs.
 */

/** A single lane's declared intent to work on a branch and set of modules. */
export type BranchLockIntent = {
  laneId: string;
  branch: string;
  worktree?: string;
  modules: string[];
};

/**
 * A collision between two or more lanes that claim overlapping module scopes on
 * the same branch.
 */
export type BranchLockCollision = {
  branch: string;
  module: string;
  laneIds: string[];
};

/**
 * Detect overlapping module-scope conflicts among a set of branch-lock intents.
 *
 * Two intents collide when they target the same branch and their module lists
 * have at least one overlapping scope (exact match or prefix/descendant).
 * Returns a sorted, deduplicated list of collisions.
 */
export function detectBranchLockCollisions(intents: BranchLockIntent[]): BranchLockCollision[] {
  const collisions: BranchLockCollision[] = [];

  for (let i = 0; i < intents.length; i++) {
    const left = intents[i];
    for (let j = i + 1; j < intents.length; j++) {
      const right = intents[j];
      if (left.branch !== right.branch) continue;
      for (const module of overlappingModules(left.modules, right.modules)) {
        collisions.push({ branch: left.branch, module, laneIds: [left.laneId, right.laneId] });
      }
    }
  }

  collisions.sort((a, b) => {
    if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1;
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    const aKey = a.laneIds.join("\0");
    const bKey = b.laneIds.join("\0");
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  // Deduplicate by identity (branch + module + laneIds tuple).
  return collisions.filter((c, idx, arr) => {
    if (idx === 0) return true;
    const prev = arr[idx - 1];
    return !(c.branch === prev.branch && c.module === prev.module && c.laneIds.join("\0") === prev.laneIds.join("\0"));
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the shared scopes for all overlapping pairs across two module lists. */
function overlappingModules(left: string[], right: string[]): string[] {
  const overlaps: string[] = [];
  for (const l of left) {
    for (const r of right) {
      if (modulesOverlap(l, r)) {
        overlaps.push(sharedScope(l, r));
      }
    }
  }
  overlaps.sort();
  return dedupe(overlaps);
}

/** True when one module is a prefix/ancestor of the other (or they are equal). */
function modulesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Return the narrower scope when one is a prefix of the other; otherwise return
 * `left` (the two are equal in that case).
 */
function sharedScope(left: string, right: string): string {
  // `right` is the ancestor when left starts with right/, so right is the shared scope.
  if (left.startsWith(`${right}/`) || left === right) return right;
  return left;
}

function dedupe<T>(sorted: T[]): T[] {
  return sorted.filter((v, i, a) => i === 0 || v !== a[i - 1]);
}
