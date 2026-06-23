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
import { GlobalToolRegistry } from "../tools/registry.js";
import type { FinishPayload, ToolExecutionResult } from "../tools/specs.js";
import { estimateTranscriptTokens } from "../workflow/context-budget.js";
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
   * Resolves rendered git context for a working directory. Injectable so tests
   * stay hermetic (no real `git` subprocess); defaults to live git detection.
   */
  gitContextProvider?: (cwd: string) => Promise<string | undefined>;
};

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TRANSCRIPT_TOKENS = 90 * 131_072 / 100;

export class ConversationRuntime {
  private readonly apiClient: ApiClient;
  private readonly toolRegistry: GlobalToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly permissionEnforcer: PermissionEnforcer;
  private readonly promptBuilder: SystemPromptBuilder;
  private readonly maxTranscriptTokens: number;
  private readonly gitContextProvider: (cwd: string) => Promise<string | undefined>;

  constructor(options: ConversationRuntimeOptions) {
    this.apiClient = options.apiClient;
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.permissionEnforcer = options.permissionEnforcer;
    this.promptBuilder = options.promptBuilder;
    this.maxTranscriptTokens = options.maxTranscriptTokens ?? DEFAULT_MAX_TRANSCRIPT_TOKENS;
    this.gitContextProvider = options.gitContextProvider ?? ((cwd) => detectAndRenderGitContext(cwd));
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

    try {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        this.compactIfNeeded(messages, transcript);

        const response = await this.requestCompletion(
          {
            model,
            messages,
            tools: this.toolRegistry.definitions({ maxPermission: sandbox }),
            toolChoice: "auto",
            reasoningEffort,
            temperature: 0.2,
          },
          input.stream === true,
          input.onDelta,
        );
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
          const result = await this.executeToolCall(input.cwd, toolCall, approvalPolicy, sandbox, permissionEnforcer);
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

  private compactIfNeeded(messages: ChatMessage[], transcript: string[]): void {
    if (estimateTranscriptTokens(transcript) <= this.maxTranscriptTokens) {
      return;
    }

    const preserved = messages.slice(0, 2);
    const recent = safeRecentMessages(messages.slice(2), 12);
    messages.length = 0;
    messages.push(...preserved, {
      role: "user",
      content: "Earlier tool transcript was compacted. Continue from the latest visible messages and preserve completed work.",
    }, ...recent);
    transcript.splice(0, Math.max(0, transcript.length - 24));
  }
}

export function createDefaultSessionStore(): SessionStore {
  return {
    create: createSession,
    complete: completeSession,
    fail: failSession,
  };
}

function safeRecentMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  const recent: ChatMessage[] = [];

  for (let index = messages.length - 1; index >= 0 && recent.length < limit; index -= 1) {
    const message = messages[index];

    if (message.role === "tool" || (message.role === "assistant" && message.tool_calls?.length)) {
      break;
    }

    recent.unshift(message);
  }

  return recent;
}
