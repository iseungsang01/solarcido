// In-memory worker-boot state machine and control registry.
// Ported from claw-rust/crates/runtime/src/worker_boot.rs.
// Deterministic: no Date.now() / Math.random() in module code.
// IDs and timestamps are injected via WorkerClock for testability.

// ---------------------------------------------------------------------------
// Clock injection
// ---------------------------------------------------------------------------

/** Injectable clock/id source for deterministic testing. */
export type WorkerClock = {
  nextId: () => number;
  nowSecs: () => number;
};

let _defaultCounter = 0;
const _defaultClock: WorkerClock = {
  nextId: () => ++_defaultCounter,
  nowSecs: () => Math.floor(Date.now() / 1000),
};

// ---------------------------------------------------------------------------
// WorkerStatus
// ---------------------------------------------------------------------------

export type WorkerStatus =
  | "spawning"
  | "trust_required"
  | "tool_permission_required"
  | "ready_for_prompt"
  | "running"
  | "finished"
  | "failed";

// ---------------------------------------------------------------------------
// WorkerFailureKind + WorkerFailure
// ---------------------------------------------------------------------------

export type WorkerFailureKind =
  | "trust_gate"
  | "tool_permission_gate"
  | "prompt_delivery"
  | "protocol"
  | "provider"
  | "startup_no_evidence";

export type WorkerFailure = {
  kind: WorkerFailureKind;
  message: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// WorkerEventKind
// ---------------------------------------------------------------------------

export type WorkerEventKind =
  | "spawning"
  | "trust_required"
  | "tool_permission_required"
  | "trust_resolved"
  | "ready_for_prompt"
  | "prompt_misdelivery"
  | "prompt_replay_armed"
  | "running"
  | "restarted"
  | "finished"
  | "failed"
  | "startup_no_evidence";

// ---------------------------------------------------------------------------
// WorkerTrustResolution
// ---------------------------------------------------------------------------

export type WorkerTrustResolution = "auto_allowlisted" | "manual_approval";

// ---------------------------------------------------------------------------
// WorkerPromptTarget
// ---------------------------------------------------------------------------

export type WorkerPromptTarget = "shell" | "wrong_target" | "wrong_task" | "unknown";

// ---------------------------------------------------------------------------
// StartupFailureClassification
// ---------------------------------------------------------------------------

export type StartupFailureClassification =
  | "trust_required"
  | "tool_permission_required"
  | "prompt_misdelivery"
  | "prompt_acceptance_timeout"
  | "transport_dead"
  | "worker_crashed"
  | "unknown";

// ---------------------------------------------------------------------------
// ToolPermissionAllowScope
// ---------------------------------------------------------------------------

export type ToolPermissionAllowScope = "session_only" | "session_or_always" | "unknown";

// ---------------------------------------------------------------------------
// WorkerTaskReceipt
// ---------------------------------------------------------------------------

export type WorkerTaskReceipt = {
  repo: string;
  taskKind: string;
  sourceSurface: string;
  expectedArtifacts: string[];
  objectivePreview: string;
};

// ---------------------------------------------------------------------------
// StartupEvidenceBundle
// ---------------------------------------------------------------------------

export type StartupEvidenceBundle = {
  lastLifecycleState: WorkerStatus;
  paneCommand: string;
  promptSentAt: number | undefined;
  promptAcceptanceState: boolean;
  trustPromptDetected: boolean;
  toolPermissionPromptDetected: boolean;
  toolPermissionPromptAgeSeconds: number | undefined;
  toolPermissionAllowScope: ToolPermissionAllowScope | undefined;
  transportHealthy: boolean;
  mcpHealthy: boolean;
  elapsedSeconds: number;
};

// ---------------------------------------------------------------------------
// WorkerEventPayload — discriminated union
// ---------------------------------------------------------------------------

export type WorkerEventPayload =
  | {
      type: "trust_prompt";
      cwd: string;
      resolution: WorkerTrustResolution | undefined;
    }
  | {
      type: "tool_permission_prompt";
      serverName: string | undefined;
      toolName: string | undefined;
      promptAgeSeconds: number;
      allowScope: ToolPermissionAllowScope;
      promptPreview: string;
    }
  | {
      type: "prompt_delivery";
      promptPreview: string;
      observedTarget: WorkerPromptTarget;
      observedCwd: string | undefined;
      observedPromptPreview: string | undefined;
      taskReceipt: WorkerTaskReceipt | undefined;
      recoveryArmed: boolean;
    }
  | {
      type: "startup_no_evidence";
      evidence: StartupEvidenceBundle;
      classification: StartupFailureClassification;
    };

// ---------------------------------------------------------------------------
// WorkerEvent
// ---------------------------------------------------------------------------

export type WorkerEvent = {
  seq: number;
  kind: WorkerEventKind;
  status: WorkerStatus;
  detail: string | undefined;
  payload: WorkerEventPayload | undefined;
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type Worker = {
  workerId: string;
  cwd: string;
  status: WorkerStatus;
  trustAutoResolve: boolean;
  trustGateCleared: boolean;
  autoRecoverPromptMisdelivery: boolean;
  promptDeliveryAttempts: number;
  promptInFlight: boolean;
  lastPrompt: string | undefined;
  expectedReceipt: WorkerTaskReceipt | undefined;
  replayPrompt: string | undefined;
  lastError: WorkerFailure | undefined;
  createdAt: number;
  updatedAt: number;
  events: WorkerEvent[];
};

// ---------------------------------------------------------------------------
// WorkerReadySnapshot
// ---------------------------------------------------------------------------

export type WorkerReadySnapshot = {
  workerId: string;
  status: WorkerStatus;
  ready: boolean;
  blocked: boolean;
  replayPromptReady: boolean;
  lastError: WorkerFailure | undefined;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Trim prompt to at most 48 characters for display. */
function promptPreview(prompt: string): string {
  const trimmed = prompt.trim();
  if ([...trimmed].length <= 48) return trimmed;
  return [...trimmed].slice(0, 48).join("").trimEnd() + "…";
}

function pushEvent(
  worker: Worker,
  kind: WorkerEventKind,
  status: WorkerStatus,
  detail: string | undefined,
  payload: WorkerEventPayload | undefined,
  clock: WorkerClock,
): void {
  const timestamp = clock.nowSecs();
  const seq = worker.events.length + 1;
  worker.updatedAt = timestamp;
  worker.status = status;
  worker.events.push({ seq, kind, status, detail, payload, timestamp });
}

function pathMatchesAllowlist(cwd: string, trustedRoot: string): boolean {
  // Normalise separators then check prefix containment.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const c = norm(cwd);
  const r = norm(trustedRoot);
  return c === r || c.startsWith(r + "/");
}

// ---------------------------------------------------------------------------
// Screen-text detectors
// ---------------------------------------------------------------------------

const TRUST_PROMPT_CUES = [
  "do you trust the files in this folder",
  "trust the files in this folder",
  "trust this folder",
  "allow and continue",
  "yes, proceed",
];

function detectTrustPrompt(lowered: string): boolean {
  return TRUST_PROMPT_CUES.some((cue) => lowered.includes(cue));
}

const READY_FOR_PROMPT_CUES = [
  "ready for input",
  "ready for your input",
  "ready for prompt",
  "send a message",
];

function isShellPrompt(trimmed: string): boolean {
  return (
    trimmed.endsWith("$") ||
    trimmed.endsWith("%") ||
    trimmed.endsWith("#") ||
    trimmed.startsWith("$") ||
    trimmed.startsWith("%") ||
    trimmed.startsWith("#")
  );
}

function detectReadyForPrompt(screenText: string, lowered: string): boolean {
  if (READY_FOR_PROMPT_CUES.some((cue) => lowered.includes(cue))) return true;

  const lines = screenText.split("\n");
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "");
  if (!lastNonEmpty) return false;
  const trimmed = lastNonEmpty.trim();
  if (isShellPrompt(trimmed)) return false;
  return (
    trimmed === ">" ||
    trimmed === "›" ||
    trimmed === "❯" ||
    trimmed.startsWith("> ") ||
    trimmed.startsWith("› ") ||
    trimmed.startsWith("❯ ") ||
    trimmed.includes("│ >") ||
    trimmed.includes("│ ›") ||
    trimmed.includes("│ ❯")
  );
}

const RUNNING_CUES = ["thinking", "working", "running tests", "inspecting", "analyzing"];

function detectRunningCue(lowered: string): boolean {
  return RUNNING_CUES.some((cue) => lowered.includes(cue));
}

// ---------------------------------------------------------------------------
// Tool-permission prompt detection
// ---------------------------------------------------------------------------

type ToolPermissionObservation = {
  serverName: string | undefined;
  toolName: string | undefined;
  allowScope: ToolPermissionAllowScope;
  promptPreview: string;
};

function toolPermissionMessage(obs: ToolPermissionObservation): string {
  if (obs.serverName && obs.toolName) {
    return `worker boot blocked on tool permission prompt for ${obs.serverName}.${obs.toolName}`;
  }
  if (obs.serverName) return `worker boot blocked on tool permission prompt for ${obs.serverName}`;
  if (obs.toolName) return `worker boot blocked on tool permission prompt for ${obs.toolName}`;
  return "worker boot blocked on tool permission prompt";
}

function extractQuotedValue(text: string): string | undefined {
  const start = text.indexOf('"');
  if (start === -1) return undefined;
  const end = text.indexOf('"', start + 1);
  if (end === -1) return undefined;
  return text.slice(start + 1, end);
}

function extractBetween(text: string, prefix: string, suffix: string): string | undefined {
  const start = text.indexOf(prefix);
  if (start === -1) return undefined;
  const rest = text.slice(start + prefix.length);
  const end = rest.indexOf(suffix);
  if (end === -1) return undefined;
  const value = rest.slice(0, end).trim();
  return value || undefined;
}

function extractAfter(text: string, prefix: string): string | undefined {
  const lowered = text.toLowerCase();
  const start = lowered.indexOf(prefix);
  if (start === -1) return undefined;
  const token = text
    .slice(start + prefix.length)
    .split(/\s+/)[0]
    ?.replace(/^[?:"']|[?:"']$/g, "");
  return token || undefined;
}

function extractServerFromQualifiedTool(tool: string): string | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  const rest = tool.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx === -1) return undefined;
  const server = rest.slice(0, idx);
  return server || undefined;
}

function detectToolPermissionAllowScope(lowered: string): ToolPermissionAllowScope {
  const alwaysAllow = ["always allow", "allow always", "allow this tool always", "allow for all sessions"];
  if (alwaysAllow.some((cue) => lowered.includes(cue))) return "session_or_always";
  const sessionAllow = ["allow once", "allow for this session", "allow this session", "yes, allow"];
  if (sessionAllow.some((cue) => lowered.includes(cue))) return "session_only";
  return "unknown";
}

function detectToolPermissionPrompt(
  screenText: string,
  lowered: string,
): ToolPermissionObservation | undefined {
  const looksLikePrompt =
    lowered.includes("allow the") &&
    lowered.includes("server") &&
    lowered.includes("tool") &&
    lowered.includes("run");
  const looksLikeToolGate = lowered.includes("allow tool") && lowered.includes("run");
  if (!looksLikePrompt && !looksLikeToolGate) return undefined;

  const lines = screenText.split("\n");
  const promptLine = (
    [...lines].reverse().find((line) => {
      const ll = line.toLowerCase();
      return ll.includes("allow") && ll.includes("tool") && (ll.includes("run") || ll.includes("server"));
    }) ?? screenText
  ).trim();

  const toolName =
    extractQuotedValue(promptLine) ??
    extractAfter(promptLine, "tool ")?.replace(/[?:"']/g, "");
  const serverName =
    extractBetween(promptLine, "the ", " server")?.replace(/ MCP$/, "") ??
    (toolName ? extractServerFromQualifiedTool(toolName) : undefined);

  return {
    serverName,
    toolName,
    allowScope: detectToolPermissionAllowScope(lowered),
    promptPreview: promptPreview(promptLine),
  };
}

// ---------------------------------------------------------------------------
// Prompt-misdelivery detection
// ---------------------------------------------------------------------------

type PromptDeliveryObservation = {
  target: WorkerPromptTarget;
  observedCwd: string | undefined;
  observedPromptPreview: string | undefined;
};

function detectPromptEcho(screenText: string): string | undefined {
  for (const line of screenText.split("\n")) {
    const stripped = line.trimStart().replace(/^›/, "").trim();
    if (line.trimStart().startsWith("›") && stripped) return stripped;
  }
  return undefined;
}

function isShellPromptToken(token: string): boolean {
  return ["$", "%", "#", ">", "›", "❯"].includes(token);
}

function looksLikeCwdLabel(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate.startsWith(".") ||
    candidate.includes("/")
  );
}

function detectObservedShellCwd(screenText: string): string | undefined {
  for (const line of screenText.split("\n")) {
    const tokens = line.split(/\s+/);
    const promptIdx = tokens.findIndex((t) => isShellPromptToken(t));
    if (promptIdx > 0) {
      const candidate = tokens[promptIdx - 1];
      if (candidate && looksLikeCwdLabel(candidate)) return candidate;
    }
  }
  return undefined;
}

function cwdMatchesObservedTarget(expectedCwd: string, observedCwd: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const e = norm(expectedCwd);
  const o = norm(observedCwd);
  const eBase = e.split("/").pop() ?? e;
  const oBase = o.split("/").pop() ?? o;
  return e.endsWith(o) || o.endsWith(e) || eBase === oBase;
}

function taskReceiptVisible(loweredScreenText: string, receipt: WorkerTaskReceipt): boolean {
  const tokens = [
    receipt.repo.toLowerCase(),
    receipt.taskKind.toLowerCase(),
    receipt.sourceSurface.toLowerCase(),
    receipt.objectivePreview.toLowerCase(),
  ];
  return (
    tokens.every((t) => loweredScreenText.includes(t)) &&
    receipt.expectedArtifacts.every((a) => loweredScreenText.includes(a.toLowerCase()))
  );
}

const SHELL_ERROR_CUES = [
  "command not found",
  "syntax error near unexpected token",
  "parse error near",
  "no such file or directory",
  "unknown command",
];

function detectPromptMisdelivery(
  screenText: string,
  lowered: string,
  prompt: string | undefined,
  expectedCwd: string,
  expectedReceipt: WorkerTaskReceipt | undefined,
): PromptDeliveryObservation | undefined {
  if (!prompt) return undefined;
  const promptSnippet = (prompt.split("\n").find((l) => l.trim()) ?? "")
    .trim()
    .toLowerCase();
  if (!promptSnippet) return undefined;

  const promptVisible = lowered.includes(promptSnippet);
  const observedPromptPreview = detectPromptEcho(screenText);

  if (expectedReceipt) {
    const receiptVisible = taskReceiptVisible(lowered, expectedReceipt);
    const mismatchedPromptVisible =
      observedPromptPreview !== undefined &&
      !observedPromptPreview.toLowerCase().includes(promptSnippet);

    if ((promptVisible || mismatchedPromptVisible) && !receiptVisible) {
      return {
        target: "wrong_task",
        observedCwd: detectObservedShellCwd(screenText),
        observedPromptPreview,
      };
    }
  }

  const observedCwd = detectObservedShellCwd(screenText);
  if (observedCwd && promptVisible && !cwdMatchesObservedTarget(expectedCwd, observedCwd)) {
    return {
      target: "wrong_target",
      observedCwd,
      observedPromptPreview,
    };
  }

  const shellError = SHELL_ERROR_CUES.some((cue) => lowered.includes(cue));
  if (shellError && promptVisible) {
    return { target: "shell", observedCwd: undefined, observedPromptPreview };
  }

  return undefined;
}

function promptMisdeliveryDetail(target: WorkerPromptTarget): string {
  switch (target) {
    case "shell":
      return "shell misdelivery detected";
    case "wrong_target":
      return "prompt landed in wrong target";
    case "wrong_task":
      return "prompt receipt mismatched expected task context";
    case "unknown":
      return "prompt delivery failure detected";
  }
}

// ---------------------------------------------------------------------------
// Startup-failure classifier
// ---------------------------------------------------------------------------

function classifyStartupFailure(evidence: StartupEvidenceBundle): StartupFailureClassification {
  if (!evidence.transportHealthy) return "transport_dead";

  if (evidence.trustPromptDetected && evidence.lastLifecycleState === "trust_required") {
    return "trust_required";
  }

  if (
    evidence.toolPermissionPromptDetected &&
    evidence.lastLifecycleState === "tool_permission_required"
  ) {
    return "tool_permission_required";
  }

  if (
    evidence.promptSentAt !== undefined &&
    !evidence.promptAcceptanceState &&
    evidence.lastLifecycleState === "running"
  ) {
    return "prompt_acceptance_timeout";
  }

  if (
    evidence.promptSentAt !== undefined &&
    !evidence.promptAcceptanceState &&
    evidence.elapsedSeconds > 30
  ) {
    return "prompt_misdelivery";
  }

  if (!evidence.mcpHealthy && evidence.transportHealthy) {
    return "worker_crashed";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// WorkerRegistry
// ---------------------------------------------------------------------------

/** In-memory registry for worker boot state machines. */
export class WorkerRegistry {
  private workers = new Map<string, Worker>();
  private readonly clock: WorkerClock;

  constructor(clock: WorkerClock = _defaultClock) {
    this.clock = clock;
  }

  /**
   * Create a new worker for the given cwd.
   * If the cwd matches any entry in trustedRoots the trust gate is auto-resolvable.
   */
  create(
    cwd: string,
    trustedRoots: string[],
    autoRecoverPromptMisdelivery: boolean,
  ): Worker {
    const ts = this.clock.nowSecs();
    const id = this.clock.nextId();
    const workerId = `worker_${ts.toString(16).padStart(8, "0")}_${id}`;
    const trustAutoResolve = trustedRoots.some((root) => pathMatchesAllowlist(cwd, root));

    const worker: Worker = {
      workerId,
      cwd,
      status: "spawning",
      trustAutoResolve,
      trustGateCleared: false,
      autoRecoverPromptMisdelivery,
      promptDeliveryAttempts: 0,
      promptInFlight: false,
      lastPrompt: undefined,
      expectedReceipt: undefined,
      replayPrompt: undefined,
      lastError: undefined,
      createdAt: ts,
      updatedAt: ts,
      events: [],
    };

    pushEvent(worker, "spawning", "spawning", "worker created", undefined, this.clock);
    this.workers.set(workerId, worker);
    return this._snapshot(worker);
  }

  /** Return a snapshot of the worker, or undefined if not found. */
  get(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    return w ? this._snapshot(w) : undefined;
  }

  /**
   * Observe a screen-text scrape and advance the worker state machine.
   * Returns the updated worker snapshot or throws if the worker is not found.
   */
  observe(workerId: string, screenText: string): Worker {
    const worker = this._require(workerId);
    const lowered = screenText.toLowerCase();

    // Tool-permission gate takes priority.
    const toolPrompt = detectToolPermissionPrompt(screenText, lowered);
    if (toolPrompt) {
      worker.lastError = {
        kind: "tool_permission_gate",
        message: toolPermissionMessage(toolPrompt),
        createdAt: this.clock.nowSecs(),
      };
      pushEvent(
        worker,
        "tool_permission_required",
        "tool_permission_required",
        "tool permission prompt detected",
        {
          type: "tool_permission_prompt",
          serverName: toolPrompt.serverName,
          toolName: toolPrompt.toolName,
          promptAgeSeconds: 0,
          allowScope: toolPrompt.allowScope,
          promptPreview: toolPrompt.promptPreview,
        },
        this.clock,
      );
      return this._snapshot(worker);
    }

    // Trust gate.
    if (!worker.trustGateCleared && detectTrustPrompt(lowered)) {
      worker.lastError = {
        kind: "trust_gate",
        message: "worker boot blocked on trust prompt",
        createdAt: this.clock.nowSecs(),
      };
      pushEvent(
        worker,
        "trust_required",
        "trust_required",
        "trust prompt detected",
        { type: "trust_prompt", cwd: worker.cwd, resolution: undefined },
        this.clock,
      );

      if (worker.trustAutoResolve) {
        worker.trustGateCleared = true;
        worker.lastError = undefined;
        pushEvent(
          worker,
          "trust_resolved",
          "spawning",
          "allowlisted repo auto-resolved trust prompt",
          { type: "trust_prompt", cwd: worker.cwd, resolution: "auto_allowlisted" },
          this.clock,
        );
      } else {
        return this._snapshot(worker);
      }
    }

    // Prompt-misdelivery detection.
    const misdeliveryRelevant = worker.promptInFlight && worker.lastPrompt !== undefined;
    if (misdeliveryRelevant) {
      const observation = detectPromptMisdelivery(
        screenText,
        lowered,
        worker.lastPrompt,
        worker.cwd,
        worker.expectedReceipt,
      );
      if (observation) {
        const preview = promptPreview(worker.lastPrompt ?? "");
        let message: string;
        switch (observation.target) {
          case "shell":
            message = `worker prompt landed in shell instead of coding agent: ${preview}`;
            break;
          case "wrong_target":
            message = `worker prompt landed in the wrong target instead of ${worker.cwd}: ${preview}`;
            break;
          case "wrong_task":
            message = `worker prompt receipt mismatched the expected task context for ${worker.cwd}: ${preview}`;
            break;
          default:
            message = `worker prompt delivery failed before reaching coding agent: ${preview}`;
        }
        worker.lastError = {
          kind: "prompt_delivery",
          message,
          createdAt: this.clock.nowSecs(),
        };
        worker.promptInFlight = false;
        pushEvent(
          worker,
          "prompt_misdelivery",
          "failed",
          promptMisdeliveryDetail(observation.target),
          {
            type: "prompt_delivery",
            promptPreview: preview,
            observedTarget: observation.target,
            observedCwd: observation.observedCwd,
            observedPromptPreview: observation.observedPromptPreview,
            taskReceipt: worker.expectedReceipt,
            recoveryArmed: false,
          },
          this.clock,
        );

        if (worker.autoRecoverPromptMisdelivery) {
          worker.replayPrompt = worker.lastPrompt;
          pushEvent(
            worker,
            "prompt_replay_armed",
            "ready_for_prompt",
            "prompt replay armed after prompt misdelivery",
            {
              type: "prompt_delivery",
              promptPreview: preview,
              observedTarget: observation.target,
              observedCwd: observation.observedCwd,
              observedPromptPreview: observation.observedPromptPreview,
              taskReceipt: worker.expectedReceipt,
              recoveryArmed: true,
            },
            this.clock,
          );
        }
        return this._snapshot(worker);
      }
    }

    // Running-cue detection.
    if (detectRunningCue(lowered) && worker.promptInFlight) {
      worker.promptInFlight = false;
      worker.lastError = undefined;
      pushEvent(worker, "running", "running", undefined, undefined, this.clock);
    }

    // Ready-for-prompt detection.
    if (detectReadyForPrompt(screenText, lowered) && worker.status !== "ready_for_prompt") {
      worker.promptInFlight = false;
      if (worker.lastError?.kind === "trust_gate") worker.lastError = undefined;
      pushEvent(
        worker,
        "ready_for_prompt",
        "ready_for_prompt",
        "worker is ready for prompt delivery",
        undefined,
        this.clock,
      );
    }

    return this._snapshot(worker);
  }

  /** Manually resolve a pending trust gate. Errors if the worker is not in trust_required. */
  resolveTrust(workerId: string): Worker {
    const worker = this._require(workerId);
    if (worker.status !== "trust_required") {
      throw new Error(
        `worker ${workerId} is not waiting on trust; current status: ${worker.status}`,
      );
    }
    worker.trustGateCleared = true;
    worker.lastError = undefined;
    pushEvent(
      worker,
      "trust_resolved",
      "spawning",
      "trust prompt resolved manually",
      { type: "trust_prompt", cwd: worker.cwd, resolution: "manual_approval" },
      this.clock,
    );
    return this._snapshot(worker);
  }

  /**
   * Deliver a prompt to a worker that is ready_for_prompt.
   * Pass undefined or empty prompt to use the replay buffer.
   */
  sendPrompt(
    workerId: string,
    prompt: string | undefined,
    taskReceipt: WorkerTaskReceipt | undefined,
  ): Worker {
    const worker = this._require(workerId);
    if (worker.status !== "ready_for_prompt") {
      throw new Error(
        `worker ${workerId} is not ready for prompt delivery; current status: ${worker.status}`,
      );
    }

    const nextPrompt =
      (prompt?.trim() ? prompt.trim() : undefined) ?? worker.replayPrompt;
    if (!nextPrompt) {
      throw new Error(`worker ${workerId} has no prompt to send or replay`);
    }

    worker.promptDeliveryAttempts += 1;
    worker.promptInFlight = true;
    worker.lastPrompt = nextPrompt;
    worker.expectedReceipt = taskReceipt;
    worker.replayPrompt = undefined;
    worker.lastError = undefined;
    pushEvent(
      worker,
      "running",
      "running",
      `prompt dispatched to worker: ${promptPreview(nextPrompt)}`,
      undefined,
      this.clock,
    );
    return this._snapshot(worker);
  }

  /** Return a ready/blocked snapshot without modifying state. */
  awaitReady(workerId: string): WorkerReadySnapshot {
    const worker = this._require(workerId);
    return {
      workerId: worker.workerId,
      status: worker.status,
      ready: worker.status === "ready_for_prompt",
      blocked:
        worker.status === "trust_required" ||
        worker.status === "tool_permission_required" ||
        worker.status === "failed",
      replayPromptReady: worker.replayPrompt !== undefined,
      lastError: worker.lastError,
    };
  }

  /** Reset a worker back to spawning state. */
  restart(workerId: string): Worker {
    const worker = this._require(workerId);
    worker.trustGateCleared = false;
    worker.lastPrompt = undefined;
    worker.replayPrompt = undefined;
    worker.lastError = undefined;
    worker.promptDeliveryAttempts = 0;
    worker.promptInFlight = false;
    pushEvent(worker, "restarted", "spawning", "worker restarted", undefined, this.clock);
    return this._snapshot(worker);
  }

  /** Transition a worker to the finished terminal state. */
  terminate(workerId: string): Worker {
    const worker = this._require(workerId);
    worker.promptInFlight = false;
    pushEvent(
      worker,
      "finished",
      "finished",
      "worker terminated by control plane",
      undefined,
      this.clock,
    );
    return this._snapshot(worker);
  }

  /**
   * Classify a session completion and transition the worker to the appropriate
   * terminal state. A finish of "unknown" with zero output tokens is treated as
   * a provider failure.
   */
  observeCompletion(workerId: string, finishReason: string, tokensOutput: number): Worker {
    const worker = this._require(workerId);
    const isProviderFailure =
      (finishReason === "unknown" && tokensOutput === 0) || finishReason === "error";

    if (isProviderFailure) {
      const message =
        finishReason === "unknown" && tokensOutput === 0
          ? "session completed with finish='unknown' and zero output — provider degraded or context exhausted"
          : `session failed with finish='${finishReason}' — provider error`;
      worker.lastError = {
        kind: "provider",
        message,
        createdAt: this.clock.nowSecs(),
      };
      worker.promptInFlight = false;
      pushEvent(
        worker,
        "failed",
        "failed",
        "provider failure classified",
        undefined,
        this.clock,
      );
    } else {
      worker.promptInFlight = false;
      worker.lastError = undefined;
      pushEvent(
        worker,
        "finished",
        "finished",
        `session completed: finish='${finishReason}', tokens=${tokensOutput}`,
        undefined,
        this.clock,
      );
    }
    return this._snapshot(worker);
  }

  /**
   * Emit a typed startup_no_evidence event with an evidence bundle when the
   * worker startup times out without a clear signal.
   */
  observeStartupTimeout(
    workerId: string,
    paneCommand: string,
    transportHealthy: boolean,
    mcpHealthy: boolean,
  ): Worker {
    const worker = this._require(workerId);
    const now = this.clock.nowSecs();
    const elapsed = now - worker.createdAt;

    const latestToolPermissionEvent = [...worker.events]
      .reverse()
      .find((e) => e.kind === "tool_permission_required");

    const toolPermissionAllowScope =
      latestToolPermissionEvent?.payload?.type === "tool_permission_prompt"
        ? latestToolPermissionEvent.payload.allowScope
        : undefined;

    const toolPermissionPromptAgeSeconds =
      latestToolPermissionEvent !== undefined
        ? now - latestToolPermissionEvent.timestamp
        : undefined;

    const evidence: StartupEvidenceBundle = {
      lastLifecycleState: worker.status,
      paneCommand,
      promptSentAt:
        worker.promptDeliveryAttempts > 0 ? worker.updatedAt : undefined,
      promptAcceptanceState:
        worker.status === "running" && !worker.promptInFlight,
      trustPromptDetected: worker.events.some((e) => e.kind === "trust_required"),
      toolPermissionPromptDetected: worker.events.some(
        (e) => e.kind === "tool_permission_required",
      ),
      toolPermissionPromptAgeSeconds,
      toolPermissionAllowScope,
      transportHealthy,
      mcpHealthy,
      elapsedSeconds: elapsed,
    };

    const classification = classifyStartupFailure(evidence);

    worker.lastError = {
      kind: "startup_no_evidence",
      message: `worker startup stalled after ${elapsed}s — classified as ${classification}`,
      createdAt: now,
    };
    worker.promptInFlight = false;
    pushEvent(
      worker,
      "startup_no_evidence",
      "failed",
      `startup timeout with evidence: last_state=${evidence.lastLifecycleState}, trust_detected=${evidence.trustPromptDetected}, prompt_accepted=${evidence.promptAcceptanceState}`,
      { type: "startup_no_evidence", evidence, classification },
      this.clock,
    );

    return this._snapshot(worker);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _require(workerId: string): Worker {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`worker not found: ${workerId}`);
    return w;
  }

  private _snapshot(worker: Worker): Worker {
    return {
      ...worker,
      events: worker.events.map((e) => ({ ...e })),
    };
  }
}
