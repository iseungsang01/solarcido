import OpenAI from "openai";

import { SOLAR_MODEL, UPSTAGE_BASE_URL, type ReasoningEffort } from "./constants.js";

export type SolarClientOptions = {
  apiKey?: string;
};

export function createSolarClient(options: SolarClientOptions = {}): OpenAI {
  const apiKey = options.apiKey ?? process.env.UPSTAGE_API_KEY;

  if (!apiKey) {
    throw new Error("UPSTAGE_API_KEY is required.");
  }

  return new OpenAI({
    apiKey,
    baseURL: UPSTAGE_BASE_URL,
  });
}

export type ChatRunOptions = {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
};

export async function runSolarChat(
  client: OpenAI,
  options: ChatRunOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  return client.chat.completions.create({
    model: SOLAR_MODEL,
    messages: options.messages,
    tools: options.tools,
    tool_choice: options.toolChoice,
    response_format: options.responseFormat,
    reasoning_effort: options.reasoningEffort,
    temperature: options.temperature,
    parallel_tool_calls: true,
  });
}
