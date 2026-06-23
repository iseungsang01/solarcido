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
import { createOpenAICompatibleClient } from "./providers/openai-compatible.js";
import { metadataForModel } from "./provider-registry.js";
import type { ApiClient, ChatRunOptions, ChatResponse } from "./types.js";

export type ApiClientOptions = UpstageApiClientOptions;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return createUpstageApiClient(options);
}

/**
 * Build a client for `model`, routing by the provider registry: the model's
 * provider determines the base URL (env override or default) and API-key env
 * var. Unknown models and Upstage Solar use the default Upstage client
 * (UPSTAGE_API_KEY). Anthropic is recognised but intentionally unsupported.
 */
export function createApiClientForModel(model: string, options: ApiClientOptions = {}): ApiClient {
  const meta = metadataForModel(model);

  if (!meta || meta.provider === "upstage") {
    return createUpstageApiClient(options);
  }

  if (meta.provider === "anthropic") {
    throw new Error("Anthropic provider is not supported; Solarcido ships with OpenAI-compatible providers only.");
  }

  const apiKey = options.apiKey ?? process.env[meta.authEnv];
  if (!apiKey) {
    throw new Error(`${meta.authEnv} is required for provider ${meta.provider} (model ${model}).`);
  }

  return createOpenAICompatibleClient({
    baseURL: process.env[meta.baseUrlEnv] ?? meta.defaultBaseUrl,
    apiKey,
    defaultModel: model,
    providerName: meta.provider,
  });
}

export async function runApiChat(client: ApiClient, options: ChatRunOptions): Promise<ChatResponse> {
  return client.chat(options);
}
