import { promptForCommandApproval } from "../approvals/prompt.js";
import { PermissionEnforcer } from "../runtime/permission-enforcer.js";
import { runCommand } from "../runtime/bash.js";
import { editFile, listFiles, readFile, searchFiles, writeFile } from "../runtime/file-ops.js";
import type { BuiltinTool, ToolExecutionContext, ToolExecutionResult, ToolSpec } from "./specs.js";

export const BUILTIN_TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List files under the current working directory.",
    requiredPermission: "read-only",
    inputSchema: {
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
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the working directory. A .pdf path returns extracted text.",
    requiredPermission: "read-only",
    inputSchema: {
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
  {
    name: "search_files",
    description: "Search text files in the working directory and return path:line matches.",
    requiredPermission: "read-only",
    inputSchema: {
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
  {
    name: "write_file",
    description: "Write UTF-8 text content to a file inside the working directory.",
    requiredPermission: "workspace-write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact old string with a new string. Prefer this over write_file for focused changes.",
    requiredPermission: "workspace-write",
    inputSchema: {
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
  {
    name: "run_command",
    description:
      "Run a shell command in the working directory. The result includes exit_code, stdout, and stderr instead of throwing on command failure.",
    requiredPermission: "workspace-write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
    },
  },
  {
    name: "finish",
    description: "Declare the task complete and provide a concise summary.",
    requiredPermission: "read-only",
    inputSchema: {
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
];

export const BUILTIN_TOOLS: BuiltinTool[] = BUILTIN_TOOL_SPECS.map((spec) => ({
  spec,
  execute: (input, context) => executeBuiltinTool(spec.name, input, context),
}));

export async function executeBuiltinTool(
  name: string,
  input: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const args = objectInput(input);

  switch (name) {
    case "list_files": {
      const result = await listFiles(
        context.root,
        typeof args.path === "string" ? args.path : ".",
        typeof args.depth === "number" ? args.depth : 2,
        typeof args.include_hidden === "boolean" ? args.include_hidden : false,
      );
      return { toolName: name, content: result.output };
    }
    case "read_file": {
      const result = await readFile(
        context.root,
        requireString(args.path, "path"),
        typeof args.offset === "number" ? args.offset : undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return { toolName: name, content: result.output };
    }
    case "search_files": {
      const result = await searchFiles(
        context.root,
        requireString(args.pattern, "pattern"),
        typeof args.path === "string" ? args.path : ".",
        typeof args.max_results === "number" ? args.max_results : 100,
        typeof args.case_sensitive === "boolean" ? args.case_sensitive : false,
        typeof args.regex === "boolean" ? args.regex : false,
      );
      return { toolName: name, content: result.output };
    }
    case "write_file": {
      const result = await writeFile(
        context.root,
        requireString(args.path, "path"),
        requireString(args.content, "content"),
      );
      return { toolName: name, content: result.output };
    }
    case "edit_file": {
      const result = await editFile(
        context.root,
        requireString(args.path, "path"),
        requireString(args.old_string, "old_string"),
        requireString(args.new_string, "new_string"),
        typeof args.replace_all === "boolean" ? args.replace_all : false,
      );
      return { toolName: name, content: result.output };
    }
    case "run_command": {
      const command = requireString(args.command, "command");
      const approval = await getPermissionEnforcer(context).decideCommand(command);

      if (!approval.approved) {
        return { toolName: name, content: `ERROR: ${approval.reason}` };
      }

      const result = await runCommand(
        context.root,
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
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
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

function getPermissionEnforcer(context: ToolExecutionContext): PermissionEnforcer {
  return context.permissionEnforcer ?? new PermissionEnforcer({
    approvalPolicy: context.approvalPolicy,
    sandbox: context.sandbox,
    maxPermission: context.maxPermission,
    approveCommand: promptForCommandApproval,
  });
}
