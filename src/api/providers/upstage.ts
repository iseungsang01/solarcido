import type { ApiClient } from "../types.js";
import { createOpenAICompatibleClient } from "./openai-compatible.js";

export const UPSTAGE_BASE_URL = "https://api.upstage.ai/v1";
export const DEFAULT_MODEL = "solar-pro3-260323";
export const DEFAULT_REASONING_EFFORT = "high" as const;

export type UpstageApiClientOptions = {
  apiKey?: string;
};

export function createUpstageApiClient(options: UpstageApiClientOptions = {}): ApiClient {
  const apiKey = options.apiKey ?? process.env.UPSTAGE_API_KEY;

  if (!apiKey) {
    throw new Error("UPSTAGE_API_KEY is required.");
  }

  return createOpenAICompatibleClient({
    baseURL: process.env.UPSTAGE_BASE_URL ?? UPSTAGE_BASE_URL,
    apiKey,
    defaultModel: DEFAULT_MODEL,
    providerName: "upstage",
  });
}
