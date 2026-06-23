import {
  blockedPrematureFinishMessage,
  goalLikelyRequiresModification,
  isSuccessfulModificationTool,
} from "../agents/execution-guard.js";
import type { ApiClient, ChatMessage, ChatToolCall, ReasoningEffort } from "../api/client.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../api/client.js";
import { classifyApiError, formatClassifiedError } from "../api/errors.js";
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
};

export type TurnSummary = {
  session: SessionRecord;
  finish: FinishPayload;
  transcript: string[];
  turns: number;
};

export type SessionStore = {
  create(options: CreateSessionOptions): Promise<SessionRecord>;
  complete(session: SessionRecord, update: { summary: string; changedFiles: string[]; nextSteps: string[] }): Promise<SessionRecord>;
  fail(session: SessionRecord, error: string): Promise<SessionRecord>;
};

export type ConversationRuntimeOptions = {
  apiClient: ApiClient;
  toolRegistry: GlobalToolRegistry;
  sessionStore: SessionStore;
  permissionEnforcer: PermissionEnforcer;
  promptBuilder: SystemPromptBuilder;
  maxTranscriptTokens?: number;
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

  constructor(options: ConversationRuntimeOptions) {
    this.apiClient = options.apiClient;
    this.toolRegistry = options.toolRegistry;
    this.sessionStore = options.sessionStore;
    this.permissionEnforcer = options.permissionEnforcer;
    this.promptBuilder = options.promptBuilder;
    this.maxTranscriptTokens = options.maxTranscriptTokens ?? DEFAULT_MAX_TRANSCRIPT_TOKENS;
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
    let session = await this.sessionStore.create({
      goal: input.goal,
      cwd: input.cwd,
      model,
      reasoningEffort,
      approvalPolicy,
      sandbox,
    });

    const transcript: string[] = [];
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.promptBuilder.build({ cwd: input.cwd, approvalPolicy, sandbox }),
      },
      {
        role: "user",
        content: [`Goal: ${input.goal}`, `Working directory: ${input.cwd}`].join("\n"),
      },
    ];

    try {
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        this.compactIfNeeded(messages, transcript);

        const response = await this.apiClient.chat({
          model,
          messages,
          tools: this.toolRegistry.definitions({ maxPermission: sandbox }),
          toolChoice: "auto",
          reasoningEffort,
          temperature: 0.2,
        });
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
            });
            return { session, finish: result.finish, transcript, turns: turn };
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
