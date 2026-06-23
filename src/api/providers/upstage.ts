import OpenAI from "openai";

import type {
  ApiClient,
  ChatMessage,
  ChatResponse,
  ChatRunOptions,
  ChatStreamEvent,
  ChatToolCall,
} from "../types.js";

export const UPSTAGE_BASE_URL = "https://api.upstage.ai/v1";
export const DEFAULT_MODEL = "solar-pro3-260323";
export const DEFAULT_REASONING_EFFORT = "high" as const;

export type UpstageApiClientOptions = {
  apiKey?: string;
};

class UpstageApiClient implements ApiClient {
  private readonly client: OpenAI;

  constructor(options: UpstageApiClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.UPSTAGE_API_KEY;

    if (!apiKey) {
      throw new Error("UPSTAGE_API_KEY is required.");
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: UPSTAGE_BASE_URL,
    });
  }

  async chat(options: ChatRunOptions): Promise<ChatResponse> {
    return this.client.chat.completions.create({
      ...this.baseParams(options),
    }) as Promise<ChatResponse>;
  }

  async *chatStream(options: ChatRunOptions): AsyncIterable<ChatStreamEvent> {
    const stream = (await this.client.chat.completions.create({
      ...this.baseParams(options),
      stream: true,
      stream_options: { include_usage: true },
    })) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let content = "";
    const toolCalls: ChatToolCall[] = [];
    let usage: ChatResponse["usage"];

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        yield { type: "delta", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const existing = toolCalls[index] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        toolCalls[index] = existing;
      }
      if (chunk.usage) {
        usage = chunk.usage as ChatResponse["usage"];
      }
    }

    const message: ChatMessage = { role: "assistant", content: content.length > 0 ? content : null };
    const finalToolCalls = toolCalls.filter(Boolean);
    if (finalToolCalls.length > 0) {
      message.tool_calls = finalToolCalls;
    }

    yield { type: "done", response: { choices: [{ message }], usage } };
  }

  private baseParams(options: ChatRunOptions): OpenAI.Chat.Completions.ChatCompletionCreateParams {
    return {
      model: options.model ?? DEFAULT_MODEL,
      messages: options.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      tool_choice: options.toolChoice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined,
      response_format: options.responseFormat as OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"],
      reasoning_effort: options.reasoningEffort,
      temperature: options.temperature,
    };
  }
}

export function createUpstageApiClient(options: UpstageApiClientOptions = {}): ApiClient {
  return new UpstageApiClient(options);
}
