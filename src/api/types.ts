export type ApiProviderName = "upstage" | "openai-compatible";

export type ReasoningEffort = "low" | "medium" | "high";

export type ChatToolCall = {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatToolChoice = "none" | "auto" | "required" | Record<string, unknown>;
export type ChatResponseFormat = Record<string, unknown>;

export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ChatResponse = {
  choices: Array<{
    message?: ChatMessage;
  }>;
  usage?: ChatUsage;
};

export type ChatRunOptions = {
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: ChatToolChoice;
  responseFormat?: ChatResponseFormat;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  model?: string;
};

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; response: ChatResponse };

export interface ApiClient {
  chat(options: ChatRunOptions): Promise<ChatResponse>;
  /** Optional streaming variant: yields text deltas, then a final `done` with the full response. */
  chatStream?(options: ChatRunOptions): AsyncIterable<ChatStreamEvent>;
}
