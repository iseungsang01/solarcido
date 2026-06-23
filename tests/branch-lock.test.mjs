import assert from "node:assert/strict";
import test from "node:test";

import { detectBranchLockCollisions } from "../dist/runtime/branch-lock.js";

// ---------------------------------------------------------------------------
// detectBranchLockCollisions — pure, no git calls needed
// ---------------------------------------------------------------------------

test("detects same branch same module collision", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "feature/lock", worktree: "wt-a", modules: ["runtime/mcp"] },
    { laneId: "lane-b", branch: "feature/lock", worktree: "wt-b", modules: ["runtime/mcp"] },
  ]);

  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].branch, "feature/lock");
  assert.equal(collisions[0].module, "runtime/mcp");
  assert.deepEqual(collisions[0].laneIds, ["lane-a", "lane-b"]);
});

test("detects nested module scope collision (ancestor wins as shared scope)", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "feature/lock", modules: ["runtime"] },
    { laneId: "lane-b", branch: "feature/lock", modules: ["runtime/mcp"] },
  ]);

  assert.equal(collisions.length, 1);
  // "runtime" is the ancestor — it is the shared scope.
  assert.equal(collisions[0].module, "runtime");
});

test("detects descendant-to-ancestor collision (child declared first)", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: ["runtime/mcp"] },
    { laneId: "lane-b", branch: "main", modules: ["runtime"] },
  ]);

  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].module, "runtime");
});

test("ignores different branches", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "feature/a", modules: ["runtime/mcp"] },
    { laneId: "lane-b", branch: "feature/b", modules: ["runtime/mcp"] },
  ]);

  assert.equal(collisions.length, 0);
});

test("returns empty array for a single intent", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: ["src"] },
  ]);

  assert.equal(collisions.length, 0);
});

test("returns empty array when modules do not overlap", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: ["src/api"] },
    { laneId: "lane-b", branch: "main", modules: ["src/cli"] },
  ]);

  assert.equal(collisions.length, 0);
});

test("returns empty array for empty intents list", () => {
  assert.deepEqual(detectBranchLockCollisions([]), []);
});

test("deduplicates identical collisions", () => {
  // Three lanes on the same branch/module — produces lane-a/lane-b and lane-a/lane-c
  // (and lane-b/lane-c), but no duplicates within each pair.
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: ["shared"] },
    { laneId: "lane-b", branch: "main", modules: ["shared"] },
    { laneId: "lane-c", branch: "main", modules: ["shared"] },
  ]);

  // Three pairs: (a,b), (a,c), (b,c) — none are identical.
  assert.equal(collisions.length, 3);
  const pairs = collisions.map((c) => c.laneIds.join(","));
  assert.deepEqual(pairs, ["lane-a,lane-b", "lane-a,lane-c", "lane-b,lane-c"]);
});

test("result is sorted by branch then module", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "zz", modules: ["mod-b"] },
    { laneId: "lane-b", branch: "zz", modules: ["mod-b"] },
    { laneId: "lane-c", branch: "aa", modules: ["mod-a"] },
    { laneId: "lane-d", branch: "aa", modules: ["mod-a"] },
  ]);

  assert.equal(collisions.length, 2);
  assert.equal(collisions[0].branch, "aa");
  assert.equal(collisions[1].branch, "zz");
});

test("no collision when modules list is empty for one lane", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: [] },
    { laneId: "lane-b", branch: "main", modules: ["src"] },
  ]);

  assert.equal(collisions.length, 0);
});

test("no collision when both modules lists are empty", () => {
  const collisions = detectBranchLockCollisions([
    { laneId: "lane-a", branch: "main", modules: [] },
    { laneId: "lane-b", branch: "main", modules: [] },
  ]);

  assert.equal(collisions.length, 0);
});
