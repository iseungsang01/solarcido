import assert from "node:assert/strict";
import test from "node:test";

import {
  LaneEventBuilder,
  classifyEventTerminality,
  classifyNudge,
  computeEventFingerprint,
  dedupeSupersededCommitEvents,
  dedupeTerminalEvents,
  eventsMateriallyDiffer,
  filterByConfidence,
  filterByEnvironment,
  filterByProvenance,
  isLiveLaneEvent,
  isTerminalEvent,
  isTestEvent,
  laneEventBlocked,
  laneEventCommitCreated,
  laneEventFailed,
  laneEventFinished,
  laneEventShipCommitsSelected,
  laneEventShipMerged,
  laneEventShipPrepared,
  laneEventShipPushedMain,
  laneEventStarted,
  laneEventSuperseded,
  makeLaneEvent,
  makeSessionIdentity,
  makeSessionIdentityWithPlaceholder,
  reconcileEnrichedSessionIdentity,
  reconcileTerminalEvents,
} from "../dist/runtime/lane-events.js";

// ---------------------------------------------------------------------------
// LaneEvent name / status constants
// ---------------------------------------------------------------------------

test("isTerminalEvent detects terminal states", () => {
  assert.equal(isTerminalEvent("lane.finished"), true);
  assert.equal(isTerminalEvent("lane.failed"), true);
  assert.equal(isTerminalEvent("lane.superseded"), true);
  assert.equal(isTerminalEvent("lane.closed"), true);
  assert.equal(isTerminalEvent("lane.merged"), true);

  assert.equal(isTerminalEvent("lane.started"), false);
  assert.equal(isTerminalEvent("lane.ready"), false);
  assert.equal(isTerminalEvent("lane.blocked"), false);
});

test("classifyEventTerminality classifies correctly", () => {
  assert.equal(classifyEventTerminality("lane.finished"), "terminal");
  assert.equal(classifyEventTerminality("lane.failed"), "terminal");
  assert.equal(classifyEventTerminality("lane.merged"), "terminal");
  assert.equal(classifyEventTerminality("lane.superseded"), "terminal");
  assert.equal(classifyEventTerminality("lane.closed"), "terminal");
  assert.equal(classifyEventTerminality("lane.reconciled"), "uncertainty");
  assert.equal(classifyEventTerminality("lane.started"), "advisory");
  assert.equal(classifyEventTerminality("lane.ready"), "advisory");
});

// ---------------------------------------------------------------------------
// computeEventFingerprint
// ---------------------------------------------------------------------------

test("computeEventFingerprint is deterministic for same inputs", () => {
  const fp1 = computeEventFingerprint("lane.finished", "completed", { commit: "abc123" });
  const fp2 = computeEventFingerprint("lane.finished", "completed", { commit: "abc123" });
  assert.equal(fp1, fp2, "same inputs should produce same fingerprint");
  assert.equal(fp1.length, 16, "fingerprint should be 16 hex chars");
});

test("computeEventFingerprint differs for different inputs", () => {
  const fp1 = computeEventFingerprint("lane.finished", "completed", undefined);
  const fp2 = computeEventFingerprint("lane.failed", "failed", undefined);
  const fp3 = computeEventFingerprint("lane.finished", "completed", { commit: "abc123" });
  assert.notEqual(fp1, fp2, "different event/status should differ");
  assert.notEqual(fp1, fp3, "different data should differ");
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

test("laneEventStarted creates a running event", () => {
  const ev = laneEventStarted("2026-01-01T00:00:00Z");
  assert.equal(ev.event, "lane.started");
  assert.equal(ev.status, "running");
  assert.equal(ev.emittedAt, "2026-01-01T00:00:00Z");
});

test("laneEventFinished carries optional detail", () => {
  const ev = laneEventFinished("2026-01-01T00:00:01Z", "all done");
  assert.equal(ev.event, "lane.finished");
  assert.equal(ev.status, "completed");
  assert.equal(ev.detail, "all done");
});

test("laneEventBlocked carries failure class and detail", () => {
  const ev = laneEventBlocked("2026-01-01T00:00:02Z", {
    failureClass: "mcp_startup",
    detail: "broken server",
    subphase: { kind: "mcp_handshake", serverName: "test-server", attempt: 1 },
  });
  assert.equal(ev.event, "lane.blocked");
  assert.equal(ev.status, "blocked");
  assert.equal(ev.failureClass, "mcp_startup");
  assert.equal(ev.detail, "broken server");
  assert.deepEqual(ev.data, { kind: "mcp_handshake", serverName: "test-server", attempt: 1 });
});

test("laneEventFailed carries failure class and detail", () => {
  const ev = laneEventFailed("2026-01-01T00:00:03Z", {
    failureClass: "compile",
    detail: "type error",
  });
  assert.equal(ev.event, "lane.failed");
  assert.equal(ev.status, "failed");
  assert.equal(ev.failureClass, "compile");
  assert.equal(ev.detail, "type error");
});

test("laneEventCommitCreated carries provenance data", () => {
  const ev = laneEventCommitCreated(
    "2026-01-01T00:00:04Z",
    { commit: "abc123", branch: "feature/x", lineage: [] },
    "commit created",
  );
  assert.equal(ev.event, "lane.commit.created");
  assert.equal(ev.status, "completed");
  assert.equal(ev.detail, "commit created");
  assert.deepEqual(ev.data, { commit: "abc123", branch: "feature/x", lineage: [] });
});

test("laneEventShipPrepared carries ship provenance", () => {
  const provenance = {
    sourceBranch: "feature/provenance",
    baseCommit: "dd73962",
    commitCount: 6,
    commitRange: "dd73962..c956f78",
    mergeMethod: "direct_push",
    actor: "bot",
  };
  const ev = laneEventShipPrepared("2026-04-20T14:30:00Z", provenance);
  assert.equal(ev.event, "ship.prepared");
  assert.equal(ev.status, "ready");
  assert.deepEqual(ev.data, provenance);
});

test("laneEventShipCommitsSelected formats detail string", () => {
  const ev = laneEventShipCommitsSelected("2026-04-20T14:31:00Z", 6, "dd73962..c956f78");
  assert.equal(ev.event, "ship.commits_selected");
  assert.equal(ev.detail, "6 commits: dd73962..c956f78");
});

test("laneEventShipMerged and ShipPushedMain carry provenance", () => {
  const provenance = {
    sourceBranch: "feature/y",
    baseCommit: "aaa",
    commitCount: 1,
    commitRange: "aaa..bbb",
    mergeMethod: "fast_forward",
    actor: "ci",
  };
  const merged = laneEventShipMerged("2026-04-20T14:32:00Z", provenance);
  assert.equal(merged.event, "ship.merged");
  const pushed = laneEventShipPushedMain("2026-04-20T14:33:00Z", provenance);
  assert.equal(pushed.event, "ship.pushed_main");
  assert.deepEqual(pushed.data, provenance);
});

// ---------------------------------------------------------------------------
// LaneEventBuilder
// ---------------------------------------------------------------------------

test("LaneEventBuilder builds event with full metadata", () => {
  const identity = makeSessionIdentity("test-lane", "/tmp", "test purpose");
  const ev = new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 42, "test")
    .withSessionIdentity(identity)
    .withOwnership({ owner: "bot-1", workflowScope: "test-suite", watcherAction: "observe" })
    .withNudgeId("nudge-123")
    .withDetail("starting test run")
    .build();

  assert.equal(ev.event, "lane.started");
  assert.equal(ev.metadata.seq, 42);
  assert.equal(ev.metadata.provenance, "test");
  assert.equal(ev.metadata.sessionIdentity?.title, "test-lane");
  assert.equal(ev.metadata.ownership?.owner, "bot-1");
  assert.equal(ev.metadata.nudgeId, "nudge-123");
  assert.equal(ev.detail, "starting test run");
});

test("LaneEventBuilder.buildTerminal attaches a fingerprint", () => {
  const ev = new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:00Z", 0, "live_lane")
    .buildTerminal();
  assert.ok(ev.metadata.eventFingerprint, "fingerprint should be set");
  assert.equal(ev.metadata.eventFingerprint?.length, 16);
});

test("LaneEventBuilder withEnvironment and withConfidence", () => {
  const ev = new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:00Z", 0, "live_lane")
    .withEnvironment("production")
    .withConfidence("high")
    .build();
  assert.equal(ev.metadata.environmentLabel, "production");
  assert.equal(ev.metadata.confidenceLevel, "high");
});

// ---------------------------------------------------------------------------
// eventsMateriallyDiffer
// ---------------------------------------------------------------------------

test("eventsMateriallyDiffer detects different failure class", () => {
  const a = new LaneEventBuilder("lane.failed", "failed", "2026-04-04T00:00:00Z", 0, "live_lane")
    .withFailureClass("compile")
    .buildTerminal();
  const b = new LaneEventBuilder("lane.failed", "failed", "2026-04-04T00:00:01Z", 1, "live_lane")
    .withFailureClass("test")
    .buildTerminal();
  assert.equal(eventsMateriallyDiffer(a, b), true);
});

test("eventsMateriallyDiffer returns false for identical events", () => {
  const a = makeLaneEvent("lane.finished", "completed", "2026-01-01T00:00:00Z");
  const b = makeLaneEvent("lane.finished", "completed", "2026-01-01T00:00:01Z");
  assert.equal(eventsMateriallyDiffer(a, b), false);
});

// ---------------------------------------------------------------------------
// dedupeTerminalEvents
// ---------------------------------------------------------------------------

test("dedupeTerminalEvents suppresses duplicate terminal fingerprints", () => {
  const ev1 = new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:00Z", 0, "live_lane")
    .buildTerminal();
  const ev2 = new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:01Z", 1, "live_lane")
    .build();
  const ev3 = new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:02Z", 2, "live_lane")
    .buildTerminal(); // same fingerprint as ev1

  const deduped = dedupeTerminalEvents([ev1, ev2, ev3]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].event, "lane.finished");
  assert.equal(deduped[1].event, "lane.started");
});

// ---------------------------------------------------------------------------
// dedupeSupersededCommitEvents
// ---------------------------------------------------------------------------

test("dedupeSupersededCommitEvents removes superseded entries", () => {
  const retained = dedupeSupersededCommitEvents([
    laneEventCommitCreated(
      "2026-04-04T00:00:00Z",
      { commit: "old123", branch: "feature/x", worktree: "wt-a", canonicalCommit: "canon123", supersededBy: "new123", lineage: ["old123", "new123"] },
      "old",
    ),
    laneEventCommitCreated(
      "2026-04-04T00:00:01Z",
      { commit: "new123", branch: "feature/x", worktree: "wt-b", canonicalCommit: "canon123", lineage: ["old123", "new123"] },
      "new",
    ),
  ]);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].detail, "new");
});

// ---------------------------------------------------------------------------
// reconcileTerminalEvents
// ---------------------------------------------------------------------------

test("reconcileTerminalEvents returns undefined for empty input", () => {
  assert.equal(reconcileTerminalEvents([]), undefined);
});

test("reconcileTerminalEvents sorts by monotonic sequence", () => {
  const events = [
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:02Z", 2, "live_lane").build(),
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 0, "live_lane").build(),
    new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:01Z", 1, "live_lane").build(),
  ];
  const [terminal] = reconcileTerminalEvents(events);
  assert.equal(terminal.event, "lane.finished");
  assert.equal(terminal.metadata.seq, 2);
});

test("reconcileTerminalEvents deduplicates same fingerprint", () => {
  const events = [
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:00Z", 0, "live_lane").buildTerminal(),
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:01Z", 1, "live_lane").buildTerminal(),
  ];
  const [terminal] = reconcileTerminalEvents(events);
  assert.equal(terminal.event, "lane.finished");
});

test("reconcileTerminalEvents detects transport-death uncertainty", () => {
  const events = [
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:00Z", 0, "live_lane").buildTerminal(),
    new LaneEventBuilder("lane.reconciled", "reconciled", "2026-04-04T00:00:01Z", 1, "transport").build(),
  ];
  const [terminal, rest] = reconcileTerminalEvents(events);
  assert.equal(terminal.event, "lane.reconciled");
  assert.equal(terminal.status, "reconciled");
  assert.ok(terminal.detail?.includes("transport died after terminal event"));
  assert.equal(rest.length, 1);
});

test("reconcileTerminalEvents handles completed→noisy→failed→completed", () => {
  const events = [
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:00Z", 0, "live_lane").buildTerminal(),
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:01Z", 1, "live_lane").build(),
    new LaneEventBuilder("lane.failed", "failed", "2026-04-04T00:00:02Z", 2, "live_lane").withFailureClass("infra").buildTerminal(),
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:03Z", 3, "live_lane").buildTerminal(),
  ];
  const [terminal] = reconcileTerminalEvents(events);
  assert.equal(terminal.event, "lane.finished");
  assert.equal(terminal.status, "completed");
});

test("reconcileTerminalEvents returns undefined for advisory-only events", () => {
  const events = [
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 0, "live_lane").build(),
    new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:01Z", 1, "live_lane").build(),
  ];
  assert.equal(reconcileTerminalEvents(events), undefined);
});

// ---------------------------------------------------------------------------
// SessionIdentity helpers
// ---------------------------------------------------------------------------

test("makeSessionIdentity creates complete identity", () => {
  const id = makeSessionIdentity("my-lane", "/tmp/repo", "implement feature X");
  assert.equal(id.title, "my-lane");
  assert.equal(id.workspace, "/tmp/repo");
  assert.equal(id.purpose, "implement feature X");
  assert.equal(id.placeholderReason, undefined);
});

test("makeSessionIdentityWithPlaceholder sets placeholderReason", () => {
  const id = makeSessionIdentityWithPlaceholder(
    "untitled", "/tmp/unknown", "unknown", "session created before title was known",
  );
  assert.equal(id.placeholderReason, "session created before title was known");
});

test("reconcileEnrichedSessionIdentity updates fields and clears placeholder", () => {
  const initial = makeSessionIdentityWithPlaceholder("untitled", "/tmp/unknown", "unknown", "awaiting title");
  const enriched = reconcileEnrichedSessionIdentity(initial, "feature-branch-123");
  assert.equal(enriched.title, "feature-branch-123");
  assert.equal(enriched.workspace, "/tmp/unknown");
  assert.equal(enriched.placeholderReason, undefined);
});

test("reconcileEnrichedSessionIdentity preserves placeholder when no new data", () => {
  const initial = makeSessionIdentityWithPlaceholder("untitled", "/tmp", "unknown", "still waiting");
  const reconciled = reconcileEnrichedSessionIdentity(initial);
  assert.equal(reconciled.title, "untitled");
  assert.equal(reconciled.placeholderReason, "still waiting");
});

// ---------------------------------------------------------------------------
// Provenance / environment / confidence filters
// ---------------------------------------------------------------------------

test("filterByProvenance selects only matching events", () => {
  const events = [
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 0, "live_lane").build(),
    new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:01Z", 1, "test").build(),
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:02Z", 2, "live_lane").build(),
  ];
  const live = filterByProvenance(events, "live_lane");
  assert.equal(live.length, 2);
  const testEvs = filterByProvenance(events, "test");
  assert.equal(testEvs.length, 1);
  assert.equal(testEvs[0].event, "lane.ready");
});

test("filterByEnvironment selects matching environment label", () => {
  const events = [
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 0, "live_lane").withEnvironment("production").build(),
    new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:01Z", 1, "live_lane").withEnvironment("staging").build(),
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:02Z", 2, "live_lane").withEnvironment("production").build(),
  ];
  const prod = filterByEnvironment(events, "production");
  assert.equal(prod.length, 2);
  const staging = filterByEnvironment(events, "staging");
  assert.equal(staging.length, 1);
});

test("filterByConfidence filters by minimum confidence level", () => {
  const events = [
    new LaneEventBuilder("lane.started", "running", "2026-04-04T00:00:00Z", 0, "live_lane").withConfidence("high").build(),
    new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:01Z", 1, "live_lane").withConfidence("low").build(),
    new LaneEventBuilder("lane.finished", "completed", "2026-04-04T00:00:02Z", 2, "live_lane").withConfidence("medium").build(),
  ];
  const medAndAbove = filterByConfidence(events, "medium");
  assert.equal(medAndAbove.length, 2);
  assert.equal(medAndAbove[0].event, "lane.started");
  assert.equal(medAndAbove[1].event, "lane.finished");
});

test("isTestEvent and isLiveLaneEvent classify provenance correctly", () => {
  const testEv = new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:00Z", 0, "test").build();
  assert.equal(isTestEvent(testEv), true);
  assert.equal(isLiveLaneEvent(testEv), false);

  const liveEv = new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:00Z", 0, "live_lane").build();
  assert.equal(isTestEvent(liveEv), false);
  assert.equal(isLiveLaneEvent(liveEv), true);

  const hcEv = new LaneEventBuilder("lane.ready", "ready", "2026-04-04T00:00:00Z", 0, "healthcheck").build();
  assert.equal(isTestEvent(hcEv), true);
});

// ---------------------------------------------------------------------------
// NudgeTracking / classifyNudge
// ---------------------------------------------------------------------------

test("classifyNudge returns new for unseen nudge", () => {
  assert.equal(classifyNudge("nudge-1", [], []), "new");
});

test("classifyNudge returns stale_duplicate for acknowledged nudge", () => {
  assert.equal(classifyNudge("nudge-1", [], ["nudge-1"]), "stale_duplicate");
});

test("classifyNudge returns retry for seen-but-unacknowledged nudge", () => {
  const tracking = [{ nudgeId: "nudge-1", deliveredAt: "t", acknowledged: false, isRetry: false }];
  assert.equal(classifyNudge("nudge-1", tracking, []), "retry");
});

test("classifyNudge returns stale_duplicate when nudge already acknowledged in tracking", () => {
  const tracking = [{ nudgeId: "nudge-1", deliveredAt: "t", acknowledged: true, isRetry: false }];
  assert.equal(classifyNudge("nudge-1", tracking, []), "stale_duplicate");
});
