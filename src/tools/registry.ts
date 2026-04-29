import type OpenAI from "openai";

import { classifyCommand } from "../approvals/classify-command.js";
import { decideApproval } from "../approvals/policy.js";
import { promptForCommandApproval } from "../approvals/prompt.js";
import type { ApprovalPolicy, SandboxMode } from "../config/schema.js";
import { editFile, listFiles, readFile, searchFiles, writeFile } from "./filesystem.js";
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

export type ToolExecutionOptions = {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
};

const DEFAULT_TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
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
            include_hidden: { type: "boolean" },
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
            offset: { type: "integer", description: "1-based starting line. Use with limit for large files." },
            limit: { type: "integer", description: "Maximum number of lines to return." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search text files in the working directory and return path:line matches.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            max_results: { type: "integer" },
            case_sensitive: { type: "boolean" },
            regex: { type: "boolean", description: "Treat pattern as a JavaScript regular expression." },
          },
          required: ["pattern"],
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
        name: "edit_file",
        description:
          "Edit a file by replacing an exact old string with a new string. Prefer this over write_file for focused changes.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command in the working directory. The result includes exit_code, stdout, and stderr instead of throwing on command failure.",
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
  options: ToolExecutionOptions = DEFAULT_TOOL_EXECUTION_OPTIONS,
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { toolName: name, content: `ERROR: invalid JSON arguments: ${message}` };
  }

  try {
    switch (name) {
      case "list_files": {
        const result = await listFiles(
          root,
          typeof args.path === "string" ? args.path : ".",
          typeof args.depth === "number" ? args.depth : 2,
          typeof args.include_hidden === "boolean" ? args.include_hidden : false,
        );
        return { toolName: name, content: result.output };
      }
      case "read_file": {
        const result = await readFile(
          root,
          requireString(args.path, "path"),
          typeof args.offset === "number" ? args.offset : undefined,
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return { toolName: name, content: result.output };
      }
      case "search_files": {
        const result = await searchFiles(
          root,
          requireString(args.pattern, "pattern"),
          typeof args.path === "string" ? args.path : ".",
          typeof args.max_results === "number" ? args.max_results : 100,
          typeof args.case_sensitive === "boolean" ? args.case_sensitive : false,
          typeof args.regex === "boolean" ? args.regex : false,
        );
        return { toolName: name, content: result.output };
      }
      case "write_file": {
        if (options.sandbox === "read-only") {
          return { toolName: name, content: "ERROR: write_file is disabled in read-only sandbox mode." };
        }
        const result = await writeFile(root, requireString(args.path, "path"), requireString(args.content, "content"));
        return { toolName: name, content: result.output };
      }
      case "edit_file": {
        if (options.sandbox === "read-only") {
          return { toolName: name, content: "ERROR: edit_file is disabled in read-only sandbox mode." };
        }
        const result = await editFile(
          root,
          requireString(args.path, "path"),
          requireString(args.old_string, "old_string"),
          requireString(args.new_string, "new_string"),
          typeof args.replace_all === "boolean" ? args.replace_all : false,
        );
        return { toolName: name, content: result.output };
      }
      case "run_command": {
        const command = requireString(args.command, "command");
        const risk = classifyCommand(command);
        const approvedByUser = options.approvalPolicy === "on-request" && risk === "risky"
          ? await promptForCommandApproval(command)
          : undefined;
        const approval = decideApproval(options.approvalPolicy, risk, approvedByUser);

        if (!approval.approved) {
          return { toolName: name, content: `ERROR: ${approval.reason}` };
        }

        const result = await runCommand(
          root,
          command,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        );
        return { toolName: name, content: result.output };
      }
      case "finish": {
        const summary = requireString(args.summary, "summary");
        return {
          toolName: name,
          content: summary,
          finish: {
            summary,
            changed_files: arrayOfStrings(args.changed_files),
            next_steps: arrayOfStrings(args.next_steps),
          },
        };
      }
      default:
        return { toolName: name, content: `ERROR: unsupported tool: ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { toolName: name, content: `ERROR: ${message}` };
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }

  return value;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
