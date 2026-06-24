import {
  blockedPrematureFinishMessage,
  goalLikelyRequiresModification,
  isSuccessfulModificationTool,
} from "../agents/execution-guard.js";
import type { ApiClient, ChatMessage, ChatResponse, ChatRunOptions, ChatToolCall, ReasoningEffort } from "../api/client.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../api/client.js";
import { classifyApiError, formatClassifiedError } from "../api/errors.js";
import { detectAndRenderGitContext } from "./git-context.js";
import { addUsage, emptyUsage, normalizeUsage, type TokenUsage } from "./usage.js";
import { formatCompactSummary } from "./compaction.js";
import { compressSummary } from "./summary-compression.js";
import { HookRunner } from "./hooks.js";
import { GlobalToolRegistry } from "../tools/registry.js";
import type { FinishPayload, InteractionHandler, PlanModeState, ToolExecutionResult } from "../tools/specs.js";
import { estimateMessagesTokens, estimateTokens } from "../workflow/context-budget.js";
import { maxTokensForModel, modelTokenLimit } from "../api/provider-registry.js";
import type { ApprovalPolicy, SandboxMode } from "./config.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { SystemPromptBuilder } from "./prompt.js";
import {
  completeSession,
  createSession,
  failSession,
  type CreateSessionOptions,
  type SessionRecord,
} from "./session.js";

export type RunTurnInput = {
  goal: string;
  cwd: string;
  reasoningEffort?: ReasoningEffort;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  maxTurns?: number;
  /** Prior conversation messages to continue from (`--resume`). */
  resumeMessages?: ChatMessage[];
  /** Stream model output token-by-token (opt-in). */
  stream?: boolean;
  /** Called with each streamed text delta when streaming is enabled. */
  onDelta?: (text: string) => void;
};

export type TurnSummary = {
  session: SessionRecord;
  finish: FinishPayload;
  transcript: string[];
  turns: number;
  usage: TokenUsage;
};

export type SessionStore = {
  create(options: CreateSessionOptions): Promise<SessionRecord>;
  complete(session: SessionRecord, update: { summary: string; changedFiles: string[]; nextSteps: string[]; messages?: ChatMessage[] }): Promise<SessionRecord>;
  fail(session: SessionRecord, error: string): Promise<SessionRecord>;
};

export type ConversationRuntimeOptions = {
  apiClient: ApiClient;
  toolRegistry: GlobalToolRegistry;
  sessionStore: SessionStore;
  permissionEnforcer: PermissionEnforcer;
  promptBuilder: SystemPromptBuilder;
  maxTranscriptTokens?: number;
  /**
   * How many trailing messages compaction preserves verbatim. Defaults to 12.
   * Set to 0 to summarize everything below the head (maximum compression).
   */
  compactionRecentMessages?: number;
  /**
   * Resolves rendered git context for a working directory. Injectable so tests
   * stay hermetic (no real `git` subprocess); defaults to live git detection.
   */
  gitContextProvider?: (cwd: string) => Promise<string | undefined>;
  /**
   * Runs PreToolUse/PostToolUse hooks around each tool call. Defaults to a
   * no-op runner (no configured hooks), so tool execution is unchanged.
   */
  hookRunner?: HookRunner;
  /**
   * Builds the per-call interaction handler used by prompting tools
   * (ask_user_question, exit_plan_mode). Returns `undefined` in non-interactive
   * runs so those tools degrade gracefully. Defaults to no handler.
   */
  createInteractionHandler?: () => InteractionHandler | undefined;
};

const DEFAULT_MAX_TURNS = 20;
/**
 * Tokens reserved inside the (shared input+output) context window for the
 * model's own reply, including reasoning tokens. The transcript budget is the
 * model's context window minus this reserve, so a full transcript still leaves
 * room to answer instead of erroring with a context-window overflow.
 */
const RESERVED_OUTPUT_TOKENS = 16_384;
const FALLBACK_CONTEXT_TOKENS = 131_072;
/** Trailing messages preserved verbatim across a compaction (default). */
const DEFAULT_COMPACTION_RECENT = 12;
/** Pay for a model-generated compaction summary at most once every N turns. */
const MIN_TURNS_BETWEEN_SUMMARIES = 3;
const COMPACTION_NOTICE =
  "Earlier tool transcript was compacted. Continue from the latest visible messages and preserve completed work.";

export class ConversationRuntime {
  private readonly apiClient: ApiClient;
  private readonly toolRegistry: GlobalToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly permissionEnforcer: PermissionEnforcer;
  private readonly promptBuilder: SystemPromptBuilder;
  /** Explicit transcript-budget override; when unset the budget is derived per-run from the model's context window. */
  private readonly maxTranscriptTokensOverride?: number;
  private readonly compactionRecentLimit: number;
  private readonly gitContextProvider: (cwd: string) => Promise<string | undefined>;
  private readonly hookRunner: HookRunner;
  private readonly createInteractionHandler: () => InteractionHandler | undefined;
  /** One plan-mode flag shared across the whole conversation. */
  private readonly planMode: PlanModeState = { active: false };
  private lastSummaryTurn = Number.NEGATIVE_INFINITY;

  constructor(options: ConversationRuntimeOptions) {
    this.apiClient = options.apiClient;
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.permissionEnforcer = options.permissionEnforcer;
    this.promptBuilder = options.promptBuilder;
    this.maxTranscriptTokensOverride = options.maxTranscriptTokens;
    this.compactionRecentLimit = options.compactionRecentMessages ?? DEFAULT_COMPACTION_RECENT;
    this.gitContextProvider = options.gitContextProvider ?? ((cwd) => detectAndRenderGitContext(cwd));
    this.hookRunner = options.hookRunner ?? new HookRunner({});
    this.createInteractionHandler = options.createInteractionHandler ?? (() => undefined);
  }

  async runTurn(input: RunTurnInput): Promise<TurnSummary> {
    const reasoningEffort = input.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const model = input.model ?? DEFAULT_MODEL;
    const approvalPolicy = input.approvalPolicy ?? "on-failure";
    const sandbox = input.sandbox ?? "workspace-write";
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
    const permissionEnforcer = this.permissionEnforcer.withPolicy({
      approvalPolicy,
      sandbox,
      maxPermission: sandbox,
    });
    const requiresModification = goalLikelyRequiresModification(input.goal);
    let successfulModification = false;
    let sessionUsage = emptyUsage();
    let session = await this.sessionStore.create({
      goal: input.goal,
      cwd: input.cwd,
      model,
      reasoningEffort,
      approvalPolicy,
      sandbox,
    });

    const gitContext = await this.gitContextProvider(input.cwd).catch(() => undefined);

    const transcript: string[] = [];
    const goalMessage: ChatMessage = {
      role: "user",
      content: [`Goal: ${input.goal}`, `Working directory: ${input.cwd}`].join("\n"),
    };
    const messages: ChatMessage[] =
      input.resumeMessages && input.resumeMessages.length > 0
        ? [...input.resumeMessages, goalMessage]
        : [
            {
              role: "system",
              content: this.promptBuilder.build({ cwd: input.cwd, approvalPolicy, sandbox, gitContext }),
            },
            goalMessage,
          ];

    // Tool definitions are identical every turn; compute once and count their
    // tokens so the compaction budget reflects the *whole* request payload
    // (system + tools + messages), not just the message transcript.
    const tools = this.toolRegistry.definitions({ maxPermission: sandbox });
    const toolsTokens = estimateTokens(JSON.stringify(tools));
    const transcriptBudget = this.resolveTranscriptBudget(model);
    const contextWindow = modelTokenLimit(model)?.contextWindowTokens ?? FALLBACK_CONTEXT_TOKENS;
    const outputCeiling = maxTokensForModel(model);

    try {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        await this.compactIfNeeded(messages, transcript, turn, model, transcriptBudget, toolsTokens);

        // Cap completion tokens at what the window can still hold (input + output
        // must fit in one shared window), bounded by the model's output ceiling.
        // This *prevents* an input+output overflow rather than only recovering
        // from one, and never requests more than the remaining space allows.
        const inputTokens = estimateMessagesTokens(messages) + toolsTokens;
        const maxTokens = Math.max(256, Math.min(outputCeiling, contextWindow - inputTokens - 512));

        const requestParams: ChatRunOptions = {
          model,
          messages,
          tools,
          toolChoice: "auto",
          reasoningEffort,
          temperature: 0.2,
          maxTokens,
        };

        let response: ChatResponse;
        try {
          response = await this.requestCompletion(requestParams, input.stream === true, input.onDelta);
        } catch (error) {
          // A context-window overflow slipped past the budget estimate. Force one
          // out-of-band compaction (budget 0) and retry the turn before failing.
          if (classifyApiError(error).kind !== "context-window") {
            throw error;
          }
          // Measure shed in TOKENS, not message count: compaction replaces the
          // dropped middle with a single summary message, so dropping one huge
          // message leaves the count unchanged while the token size collapses.
          const beforeTokens = estimateMessagesTokens(messages);
          await this.compactIfNeeded(messages, transcript, turn, model, 0, toolsTokens);
          if (estimateMessagesTokens(messages) >= beforeTokens) {
            throw error; // compaction shed nothing — surface the original error
          }
          // Recompute the output budget against the now-smaller transcript.
          requestParams.maxTokens = Math.max(
            256,
            Math.min(outputCeiling, contextWindow - (estimateMessagesTokens(messages) + toolsTokens) - 512),
          );
          response = await this.requestCompletion(requestParams, input.stream === true, input.onDelta);
        }
        sessionUsage = addUsage(sessionUsage, normalizeUsage(response.usage));

        const message = response.choices[0]?.message;
        if (!message) {
          throw new Error("Conversation runtime received no assistant message.");
        }

        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.tool_calls,
        });
        if (message.content) {
          transcript.push(`assistant: ${message.content}`);
        }

        if (!message.tool_calls || message.tool_calls.length === 0) {
          messages.push({
            role: "user",
            content: "Continue with tool calls. If the task is complete, call finish with summary, changed_files, and next_steps.",
          });
          continue;
        }

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          const toolInput = toolCall.function.arguments || "{}";

          let result: ToolExecutionResult;
          const pre = await this.hookRunner.runPreToolUse(toolName, toolInput);
          if (pre.denied) {
            const reason = pre.messages.length > 0 ? `: ${pre.messages.join("; ")}` : "";
            result = { toolName, content: `ERROR: blocked by PreToolUse hook${reason}` };
          } else {
            result = await this.executeToolCall(input.cwd, toolCall, approvalPolicy, sandbox, permissionEnforcer);
            if (result.content.startsWith("ERROR:")) {
              await this.hookRunner.runPostToolUseFailure(toolName, toolInput, result.content);
            } else {
              await this.hookRunner.runPostToolUse(toolName, toolInput, result.content, false);
            }
          }

          const content = result.finish && requiresModification && !successfulModification
            ? blockedPrematureFinishMessage()
            : result.content;

          transcript.push(`tool:${result.toolName}: ${content}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content,
          });

          if (isSuccessfulModificationTool(result.toolName, content)) {
            successfulModification = true;
          }

          if (result.finish && content === result.content) {
            session = await this.sessionStore.complete(session, {
              summary: result.finish.summary,
              changedFiles: result.finish.changed_files,
              nextSteps: result.finish.next_steps,
              messages,
            });
            return { session, finish: result.finish, transcript, turns: turn, usage: sessionUsage };
          }
        }
      }

      throw new Error(`Conversation runtime exceeded maxTurns (${maxTurns}) before finish.`);
    } catch (error) {
      // Classify only to record a cleaner failure reason; re-throw the ORIGINAL
      // error unchanged so callers (and tests) observe the same thrown value.
      const message = formatClassifiedError(classifyApiError(error));
      await this.sessionStore.fail(session, message);
      throw error;
    }
  }

  private async executeToolCall(
    root: string,
    toolCall: ChatToolCall,
    approvalPolicy: ApprovalPolicy,
    sandbox: SandboxMode,
    permissionEnforcer: PermissionEnforcer,
  ): Promise<ToolExecutionResult> {
    let input: unknown;
    try {
      input = JSON.parse(toolCall.function.arguments || "{}");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { toolName: toolCall.function.name, content: `ERROR: invalid JSON arguments: ${message}` };
    }

    return this.toolRegistry.execute(toolCall.function.name, input, {
      root,
      approvalPolicy,
      sandbox,
      maxPermission: sandbox,
      permissionEnforcer,
      interaction: this.createInteractionHandler(),
      planMode: this.planMode,
    });
  }

  private async requestCompletion(
    params: ChatRunOptions,
    stream: boolean,
    onDelta?: (text: string) => void,
  ): Promise<ChatResponse> {
    if (stream && this.apiClient.chatStream) {
      let response: ChatResponse | undefined;
      for await (const event of this.apiClient.chatStream(params)) {
        if (event.type === "delta") {
          onDelta?.(event.text);
        } else {
          response = event.response;
        }
      }
      if (!response) {
        throw new Error("Streaming response ended without a completion.");
      }
      return response;
    }

    return this.apiClient.chat(params);
  }

  /**
   * Transcript token budget for `model`: the explicit override if one was given,
   * otherwise the model's real context window minus a reserve for the reply.
   * Falling back to solar-pro3's measured 131,072-token window for unknown models.
   */
  private resolveTranscriptBudget(model: string): number {
    if (this.maxTranscriptTokensOverride !== undefined) {
      return this.maxTranscriptTokensOverride;
    }
    const contextWindow = modelTokenLimit(model)?.contextWindowTokens ?? FALLBACK_CONTEXT_TOKENS;
    return Math.max(1024, contextWindow - RESERVED_OUTPUT_TOKENS);
  }

  private async compactIfNeeded(
    messages: ChatMessage[],
    transcript: string[],
    turn: number,
    model: string,
    budget: number,
    toolsTokens: number,
  ): Promise<void> {
    // Gate on the real request payload (messages + tool schemas), not the
    // side-channel transcript, which omitted tool-call argument bodies.
    if (estimateMessagesTokens(messages) + toolsTokens <= budget) {
      return;
    }

    const head = messages.slice(0, 2);
    const recent = safeRecentMessages(messages.slice(2), this.compactionRecentLimit);
    const dropped = messages.slice(head.length, messages.length - recent.length);

    // Nothing droppable (e.g. only head + recent fit): compacting would just
    // inject a spurious notice, so leave the conversation untouched.
    if (dropped.length === 0) {
      return;
    }

    const droppedText = dropped.map(renderForSummary).join("\n");

    // Prefer a model-generated summary, paid for at most once every
    // MIN_TURNS_BETWEEN_SUMMARIES turns. Off-cadence we skip the model call but
    // still preserve the dropped segment with a cheap extractive compression
    // rather than a bare notice; the notice is only the last resort.
    let summaryContent = COMPACTION_NOTICE;
    if (turn - this.lastSummaryTurn >= MIN_TURNS_BETWEEN_SUMMARIES) {
      const summary = await this.summarizeDropped(droppedText, model);
      if (summary) {
        summaryContent = formatCompactSummary(summary);
        this.lastSummaryTurn = turn;
      }
    } else {
      const compressed = compressSummary(droppedText).text;
      if (compressed.length > 0) {
        summaryContent = compressed;
      }
    }

    messages.length = 0;
    messages.push(...head, { role: "user", content: summaryContent }, ...recent);
    transcript.splice(0, Math.max(0, transcript.length - 24));
  }

  private async summarizeDropped(droppedText: string, model: string): Promise<string | undefined> {
    try {
      const segment = droppedText.slice(0, 24_000);
      const response = await this.apiClient.chat({
        model,
        messages: [
          {
            role: "system",
            content:
              "Summarize the following conversation segment in a few concise bullet points capturing decisions, files touched, and pending work. Output only the summary.",
          },
          { role: "user", content: segment },
        ],
        reasoningEffort: "low",
        temperature: 0,
      });
      const summary = response.choices[0]?.message?.content?.trim();
      return summary && summary.length > 0 ? summary : undefined;
    } catch {
      return undefined;
    }
  }
}

export function createDefaultSessionStore(): SessionStore {
  return {
    create: createSession,
    complete: completeSession,
    fail: failSession,
  };
}

/**
 * Returns the trailing slice of `messages` (up to `limit` messages), adjusted so
 * it begins at a valid boundary — never on an orphaned `tool` result whose
 * originating assistant `tool_call` was dropped. The previous implementation
 * stopped at the first tool boundary scanning backwards, so a transcript that
 * ended on a tool result (the common case in an agent loop) preserved *nothing*
 * and compaction threw away the most recent work. Keeping whole
 * assistant(tool_calls) → tool(result) groups fixes that.
 */
export function safeRecentMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0 || messages.length === 0) {
    return [];
  }

  let start = Math.max(0, messages.length - limit);
  // A leading `tool` message would reference a tool_call that is no longer in
  // the slice; skip forward until the slice starts on a self-contained message.
  while (start < messages.length && messages[start].role === "tool") {
    start += 1;
  }

  return messages.slice(start);
}

/**
 * Renders a dropped message for summarization input: its text plus a compact note
 * of any tool calls (name + truncated arguments) so the summarizer sees what was
 * done, without inlining whole file bodies.
 */
function renderForSummary(message: ChatMessage): string {
  const lines = [`${message.role}: ${message.content ?? ""}`];
  for (const call of message.tool_calls ?? []) {
    const args = (call.function?.arguments ?? "").slice(0, 200);
    lines.push(`  ↳ called ${call.function?.name ?? "tool"}(${args})`);
  }
  return lines.join("\n");
}
