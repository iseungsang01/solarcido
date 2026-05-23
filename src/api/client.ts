export {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  UPSTAGE_BASE_URL,
  createUpstageApiClient,
  type UpstageApiClientOptions,
} from "./providers/upstage.js";
export type {
  ApiClient,
  ApiProviderName,
  ChatMessage,
  ChatResponse,
  ChatResponseFormat,
  ChatRunOptions,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  ReasoningEffort,
} from "./types.js";

import { createUpstageApiClient, type UpstageApiClientOptions } from "./providers/upstage.js";
import type { ApiClient, ChatRunOptions, ChatResponse } from "./types.js";

export type ApiClientOptions = UpstageApiClientOptions;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return createUpstageApiClient(options);
}

export async function runApiChat(client: ApiClient, options: ChatRunOptions): Promise<ChatResponse> {
  return client.chat(options);
}
