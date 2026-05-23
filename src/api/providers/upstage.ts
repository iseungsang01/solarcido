import OpenAI from "openai";

import type { ApiClient, ChatRunOptions, ChatResponse } from "../types.js";

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
      model: options.model ?? DEFAULT_MODEL,
      messages: options.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: options.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      tool_choice: options.toolChoice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined,
      response_format: options.responseFormat as OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"],
      reasoning_effort: options.reasoningEffort,
      temperature: options.temperature,
    }) as Promise<ChatResponse>;
  }
}

export function createUpstageApiClient(options: UpstageApiClientOptions = {}): ApiClient {
  return new UpstageApiClient(options);
}
