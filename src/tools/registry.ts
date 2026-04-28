import type OpenAI from "openai";

import { listFiles, readFile, writeFile } from "./filesystem.js";
import { runCommand } from "./process.js";

export type FinishPayload = {
  summary: string;
  changed_files: string[];
  next_steps: string[];
};

export type ToolExecutionResult = {
  toolName: string;
  content: string;
  finish?: FinishPayload;
};

export function createToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files under the current working directory.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            depth: { type: "integer" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the working directory.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write UTF-8 text content to a file inside the working directory.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command in the working directory.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Declare the task complete and provide a concise summary.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            changed_files: {
              type: "array",
              items: { type: "string" },
            },
            next_steps: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["summary", "changed_files", "next_steps"],
        },
      },
    },
  ];
}

export async function executeToolCall(
  root: string,
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  switch (name) {
    case "list_files": {
      const result = await listFiles(root, args.path, args.depth);
      return { toolName: name, content: result.output };
    }
    case "read_file": {
      const result = await readFile(root, args.path);
      return { toolName: name, content: result.output };
    }
    case "write_file": {
      const result = await writeFile(root, args.path, args.content);
      return { toolName: name, content: result.output };
    }
    case "run_command": {
      const result = await runCommand(root, args.command, args.timeout_ms);
      return { toolName: name, content: result.output };
    }
    case "finish": {
      return {
        toolName: name,
        content: args.summary,
        finish: {
          summary: args.summary,
          changed_files: Array.isArray(args.changed_files) ? args.changed_files : [],
          next_steps: Array.isArray(args.next_steps) ? args.next_steps : [],
        },
      };
    }
    default:
      throw new Error(`Unsupported tool: ${name}`);
  }
}
