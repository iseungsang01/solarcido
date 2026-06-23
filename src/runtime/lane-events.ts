// Lane event types, metadata, builder, and deduplication helpers.
// Pure module — no I/O, no Date.now(), no Math.random().

// ---------------------------------------------------------------------------
// Enums / discriminated unions
// ---------------------------------------------------------------------------

export type LaneEventName =
  | "lane.started"
  | "lane.ready"
  | "lane.prompt_misdelivery"
  | "lane.blocked"
  | "lane.red"
  | "lane.green"
  | "lane.commit.created"
  | "lane.pr.opened"
  | "lane.merge.ready"
  | "lane.finished"
  | "lane.failed"
  | "lane.reconciled"
  | "lane.merged"
  | "lane.superseded"
  | "lane.closed"
  | "branch.stale_against_main"
  | "branch.workspace_mismatch"
  | "ship.prepared"
  | "ship.commits_selected"
  | "ship.merged"
  | "ship.pushed_main";

export type LaneEventStatus =
  | "running"
  | "ready"
  | "blocked"
  | "red"
  | "green"
  | "completed"
  | "failed"
  | "reconciled"
  | "merged"
  | "superseded"
  | "closed";

export type LaneFailureClass =
  | "prompt_delivery"
  | "trust_gate"
  | "branch_divergence"
  | "compile"
  | "test"
  | "plugin_startup"
  | "mcp_startup"
  | "mcp_handshake"
  | "gateway_routing"
  | "tool_runtime"
  | "workspace_mismatch"
  | "infra";

export type EventProvenance =
  | "live_lane"
  | "test"
  | "healthcheck"
  | "replay"
  | "transport";

export type WatcherAction = "act" | "observe" | "ignore";

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

// ---------------------------------------------------------------------------
// Supporting value types
// ---------------------------------------------------------------------------

export interface SessionIdentity {
  title: string;
  workspace: string;
  purpose: string;
  placeholderReason?: string;
}

export interface LaneOwnership {
  owner: string;
  workflowScope: string;
  watcherAction: WatcherAction;
}

export interface LaneEventMetadata {
  seq: number;
  provenance: EventProvenance;
  sessionIdentity?: SessionIdentity;
  ownership?: LaneOwnership;
  nudgeId?: string;
  eventFingerprint?: string;
  timestampMs: number;
  environmentLabel?: string;
  emitterIdentity?: string;
  confidenceLevel?: ConfidenceLevel;
}

export type BlockedSubphase =
  | { kind: "trust_prompt"; gateRepo: string }
  | { kind: "prompt_delivery"; attempt: number }
  | { kind: "plugin_init"; pluginName: string }
  | { kind: "mcp_handshake"; serverName: string; attempt: number }
  | { kind: "branch_freshness"; behindMain: number }
  | { kind: "test_hang"; elapsedSecs: number; testName?: string }
  | { kind: "report_pending"; sinceSecs: number };

export interface LaneEventBlocker {
  failureClass: LaneFailureClass;
  detail: string;
  subphase?: BlockedSubphase;
}

export interface LaneCommitProvenance {
  commit: string;
  branch: string;
  worktree?: string;
  canonicalCommit?: string;
  supersededBy?: string;
  lineage: string[];
}

export type ShipMergeMethod =
  | "direct_push"
  | "fast_forward"
  | "merge_commit"
  | "squash_merge"
  | "rebase_merge";

export interface ShipProvenance {
  sourceBranch: string;
  baseCommit: string;
  commitCount: number;
  commitRange: string;
  mergeMethod: ShipMergeMethod;
  actor: string;
  prNumber?: number;
}

// ---------------------------------------------------------------------------
// Core event type
// ---------------------------------------------------------------------------

export interface LaneEvent {
  event: LaneEventName;
  status: LaneEventStatus;
  emittedAt: string;
  failureClass?: LaneFailureClass;
  detail?: string;
  data?: unknown;
  metadata: LaneEventMetadata;
}

// ---------------------------------------------------------------------------
// Fingerprint (pure deterministic hash — no Math.random / Date.now)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, sufficient for terminal event deduplication. */
function fnv1a32(input: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // multiply by FNV prime (mod 2^32)
    hash = (Math.imul(hash, 16777619) >>> 0);
  }
  return hash >>> 0;
}

/**
 * Compute a deterministic fingerprint for terminal event deduplication.
 * Uses two FNV-1a passes to produce a 16-hex-char string.
 */
export function computeEventFingerprint(
  event: LaneEventName,
  status: LaneEventStatus,
  data?: unknown,
): string {
  const dataStr = data !== undefined ? JSON.stringify(data) : "";
  const lo = fnv1a32(`${event}\x00${status}\x00${dataStr}`);
  const hi = fnv1a32(`${status}\x00${event}\x00${dataStr}\x00hi`);
  return (hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0"));
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeMetadata(
  seq: number,
  provenance: EventProvenance,
  timestampMs: number,
): LaneEventMetadata {
  return { seq, provenance, timestampMs };
}

/** Create a new event with minimal metadata (seq=0, provenance=live_lane). */
export function makeLaneEvent(
  event: LaneEventName,
  status: LaneEventStatus,
  emittedAt: string,
  timestampMs = 0,
): LaneEvent {
  return {
    event,
    status,
    emittedAt,
    metadata: makeMetadata(0, "live_lane", timestampMs),
  };
}

export function laneEventStarted(emittedAt: string): LaneEvent {
  return makeLaneEvent("lane.started", "running", emittedAt);
}

export function laneEventFinished(emittedAt: string, detail?: string): LaneEvent {
  const ev = makeLaneEvent("lane.finished", "completed", emittedAt);
  if (detail !== undefined) ev.detail = detail;
  return ev;
}

export function laneEventBlocked(emittedAt: string, blocker: LaneEventBlocker): LaneEvent {
  const ev = makeLaneEvent("lane.blocked", "blocked", emittedAt);
  ev.failureClass = blocker.failureClass;
  ev.detail = blocker.detail;
  if (blocker.subphase !== undefined) ev.data = blocker.subphase;
  return ev;
}

export function laneEventFailed(emittedAt: string, blocker: LaneEventBlocker): LaneEvent {
  const ev = makeLaneEvent("lane.failed", "failed", emittedAt);
  ev.failureClass = blocker.failureClass;
  ev.detail = blocker.detail;
  if (blocker.subphase !== undefined) ev.data = blocker.subphase;
  return ev;
}

export function laneEventCommitCreated(
  emittedAt: string,
  provenance: LaneCommitProvenance,
  detail?: string,
): LaneEvent {
  const ev = makeLaneEvent("lane.commit.created", "completed", emittedAt);
  if (detail !== undefined) ev.detail = detail;
  ev.data = provenance;
  return ev;
}

export function laneEventSuperseded(
  emittedAt: string,
  provenance: LaneCommitProvenance,
  detail?: string,
): LaneEvent {
  const ev = makeLaneEvent("lane.superseded", "superseded", emittedAt);
  if (detail !== undefined) ev.detail = detail;
  ev.data = provenance;
  return ev;
}

export function laneEventShipPrepared(emittedAt: string, provenance: ShipProvenance): LaneEvent {
  const ev = makeLaneEvent("ship.prepared", "ready", emittedAt);
  ev.data = provenance;
  return ev;
}

export function laneEventShipCommitsSelected(
  emittedAt: string,
  commitCount: number,
  commitRange: string,
): LaneEvent {
  const ev = makeLaneEvent("ship.commits_selected", "ready", emittedAt);
  ev.detail = `${commitCount} commits: ${commitRange}`;
  return ev;
}

export function laneEventShipMerged(emittedAt: string, provenance: ShipProvenance): LaneEvent {
  const ev = makeLaneEvent("ship.merged", "completed", emittedAt);
  ev.data = provenance;
  return ev;
}

export function laneEventShipPushedMain(emittedAt: string, provenance: ShipProvenance): LaneEvent {
  const ev = makeLaneEvent("ship.pushed_main", "completed", emittedAt);
  ev.data = provenance;
  return ev;
}

// ---------------------------------------------------------------------------
// SessionIdentity helpers
// ---------------------------------------------------------------------------

export function makeSessionIdentity(
  title: string,
  workspace: string,
  purpose: string,
): SessionIdentity {
  return { title, workspace, purpose };
}

export function makeSessionIdentityWithPlaceholder(
  title: string,
  workspace: string,
  purpose: string,
  placeholderReason: string,
): SessionIdentity {
  return { title, workspace, purpose, placeholderReason };
}

export function reconcileEnrichedSessionIdentity(
  identity: SessionIdentity,
  title?: string,
  workspace?: string,
  purpose?: string,
): SessionIdentity {
  const hasNewData = title !== undefined || workspace !== undefined || purpose !== undefined;
  return {
    title: title ?? identity.title,
    workspace: workspace ?? identity.workspace,
    purpose: purpose ?? identity.purpose,
    placeholderReason: hasNewData ? undefined : identity.placeholderReason,
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class LaneEventBuilder {
  private _event: LaneEventName;
  private _status: LaneEventStatus;
  private _emittedAt: string;
  private _meta: LaneEventMetadata;
  private _detail?: string;
  private _failureClass?: LaneFailureClass;
  private _data?: unknown;

  constructor(
    event: LaneEventName,
    status: LaneEventStatus,
    emittedAt: string,
    seq: number,
    provenance: EventProvenance,
    timestampMs = 0,
  ) {
    this._event = event;
    this._status = status;
    this._emittedAt = emittedAt;
    this._meta = makeMetadata(seq, provenance, timestampMs);
  }

  withSessionIdentity(identity: SessionIdentity): this {
    this._meta = { ...this._meta, sessionIdentity: identity };
    return this;
  }

  withOwnership(ownership: LaneOwnership): this {
    this._meta = { ...this._meta, ownership };
    return this;
  }

  withNudgeId(nudgeId: string): this {
    this._meta = { ...this._meta, nudgeId };
    return this;
  }

  withDetail(detail: string): this {
    this._detail = detail;
    return this;
  }

  withFailureClass(failureClass: LaneFailureClass): this {
    this._failureClass = failureClass;
    return this;
  }

  withData(data: unknown): this {
    this._data = data;
    return this;
  }

  withEnvironment(label: string): this {
    this._meta = { ...this._meta, environmentLabel: label };
    return this;
  }

  withEmitter(emitter: string): this {
    this._meta = { ...this._meta, emitterIdentity: emitter };
    return this;
  }

  withConfidence(level: ConfidenceLevel): this {
    this._meta = { ...this._meta, confidenceLevel: level };
    return this;
  }

  /** Compute fingerprint and attach it, then build. */
  buildTerminal(): LaneEvent {
    const fingerprint = computeEventFingerprint(this._event, this._status, this._data);
    this._meta = { ...this._meta, eventFingerprint: fingerprint };
    return this.build();
  }

  build(): LaneEvent {
    const ev: LaneEvent = {
      event: this._event,
      status: this._status,
      emittedAt: this._emittedAt,
      metadata: this._meta,
    };
    if (this._failureClass !== undefined) ev.failureClass = this._failureClass;
    if (this._detail !== undefined) ev.detail = this._detail;
    if (this._data !== undefined) ev.data = this._data;
    return ev;
  }
}

// ---------------------------------------------------------------------------
// Terminality / reconciliation
// ---------------------------------------------------------------------------

export type EventTerminality = "terminal" | "advisory" | "uncertainty";

const TERMINAL_EVENTS = new Set<LaneEventName>([
  "lane.finished",
  "lane.failed",
  "lane.superseded",
  "lane.closed",
  "lane.merged",
]);

export function isTerminalEvent(event: LaneEventName): boolean {
  return TERMINAL_EVENTS.has(event);
}

export function classifyEventTerminality(event: LaneEventName): EventTerminality {
  if (TERMINAL_EVENTS.has(event)) return "terminal";
  if (event === "lane.reconciled") return "uncertainty";
  return "advisory";
}

export function eventsMateriallyDiffer(a: LaneEvent, b: LaneEvent): boolean {
  if (a.event !== b.event) return true;
  if (a.status !== b.status) return true;
  if (a.failureClass !== b.failureClass) return true;
  if (JSON.stringify(a.data) !== JSON.stringify(b.data)) return true;
  return false;
}

/**
 * Reconcile a burst of potentially contradictory events into one canonical
 * outcome. Sorts by monotonic seq, deduplicates by fingerprint, and wraps
 * in uncertainty when transport death follows a terminal event.
 */
export function reconcileTerminalEvents(
  events: LaneEvent[],
): [LaneEvent, LaneEvent[]] | undefined {
  if (events.length === 0) return undefined;

  const sorted = [...events].sort((a, b) => a.metadata.seq - b.metadata.seq);

  let lastTerminal: LaneEvent | undefined;
  let postTerminalUncertainty = false;
  const reconciledEvents: LaneEvent[] = [];

  for (const ev of sorted) {
    const terminality = classifyEventTerminality(ev.event);
    if (terminality === "terminal") {
      if (lastTerminal !== undefined) {
        const fp1 = ev.metadata.eventFingerprint;
        const fp2 = lastTerminal.metadata.eventFingerprint;
        if (fp1 !== undefined && fp2 !== undefined && fp1 === fp2) {
          continue; // duplicate fingerprint — skip
        }
        if (eventsMateriallyDiffer(lastTerminal, ev)) {
          lastTerminal = ev;
        }
      } else {
        lastTerminal = ev;
      }
    } else if (terminality === "uncertainty") {
      if (lastTerminal !== undefined) {
        postTerminalUncertainty = true;
      }
      reconciledEvents.push(ev);
    } else {
      reconciledEvents.push(ev);
    }
  }

  if (lastTerminal === undefined) return undefined;

  const finalTerminal: LaneEvent = postTerminalUncertainty
    ? {
        ...lastTerminal,
        event: "lane.reconciled",
        status: "reconciled",
        detail: "Session terminal state uncertain: transport died after terminal event",
      }
    : lastTerminal;

  return [finalTerminal, reconciledEvents];
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/** Return events with duplicate terminal fingerprints removed (first wins). */
export function dedupeTerminalEvents(events: LaneEvent[]): LaneEvent[] {
  const seen = new Set<string>();
  const result: LaneEvent[] = [];
  for (const ev of events) {
    if (isTerminalEvent(ev.event)) {
      const fp = ev.metadata.eventFingerprint;
      if (fp !== undefined) {
        if (seen.has(fp)) continue;
        seen.add(fp);
      }
    }
    result.push(ev);
  }
  return result;
}

/**
 * Remove CommitCreated events that are superseded by a later event on the
 * same canonical commit. Entries with a `supersededBy` field are dropped.
 * Among remaining entries sharing the same canonical/commit key, the latest
 * index wins.
 */
export function dedupeSupersededCommitEvents(events: LaneEvent[]): LaneEvent[] {
  const keep = new Array<boolean>(events.length).fill(true);
  const latestByKey = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.event !== "lane.commit.created") continue;
    const data = ev.data as Record<string, unknown> | undefined;
    if (data === undefined) continue;

    const superseded = data["supersededBy"] !== undefined && data["supersededBy"] !== null;
    if (superseded) {
      keep[i] = false;
      continue;
    }

    const key =
      (data["canonicalCommit"] as string | undefined) ??
      (data["commit"] as string | undefined);
    if (key !== undefined) {
      const prev = latestByKey.get(key);
      if (prev !== undefined) keep[prev] = false;
      latestByKey.set(key, i);
    }
  }

  return events.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Provenance / environment / confidence filters
// ---------------------------------------------------------------------------

export function filterByProvenance(
  events: LaneEvent[],
  provenance: EventProvenance,
): LaneEvent[] {
  return events.filter((e) => e.metadata.provenance === provenance);
}

export function filterByEnvironment(events: LaneEvent[], environment: string): LaneEvent[] {
  return events.filter((e) => e.metadata.environmentLabel === environment);
}

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

export function filterByConfidence(
  events: LaneEvent[],
  minConfidence: ConfidenceLevel,
): LaneEvent[] {
  const minLevel = CONFIDENCE_ORDER[minConfidence];
  return events.filter((e) => {
    const c = e.metadata.confidenceLevel;
    return c !== undefined && CONFIDENCE_ORDER[c] >= minLevel;
  });
}

export function isTestEvent(event: LaneEvent): boolean {
  return (
    event.metadata.provenance === "test" ||
    event.metadata.provenance === "healthcheck" ||
    event.metadata.provenance === "replay"
  );
}

export function isLiveLaneEvent(event: LaneEvent): boolean {
  return event.metadata.provenance === "live_lane";
}

// ---------------------------------------------------------------------------
// Nudge tracking
// ---------------------------------------------------------------------------

export interface NudgeTracking {
  nudgeId: string;
  deliveredAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  isRetry: boolean;
  originalNudgeId?: string;
}

export type NudgeClassification = "new" | "retry" | "stale_duplicate";

export function classifyNudge(
  nudgeId: string,
  existingTracking: NudgeTracking[],
  acknowledgedNudgeIds: string[],
): NudgeClassification {
  if (acknowledgedNudgeIds.includes(nudgeId)) return "stale_duplicate";
  for (const tracking of existingTracking) {
    if (tracking.nudgeId === nudgeId) {
      return tracking.acknowledged ? "stale_duplicate" : "retry";
    }
    if (tracking.originalNudgeId === nudgeId) return "stale_duplicate";
  }
  return "new";
}
