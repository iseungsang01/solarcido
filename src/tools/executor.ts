import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { promptForCommandApproval } from "../approvals/prompt.js";
import { PermissionEnforcer } from "../runtime/permission-enforcer.js";
import { runCommand } from "../runtime/bash.js";
import { editFile, listFiles, readFile, searchFiles, writeFile } from "../runtime/file-ops.js";
import type { BuiltinTool, ToolExecutionContext, ToolExecutionResult, ToolSpec } from "./specs.js";

type TodoStatus = "pending" | "in_progress" | "completed";
type TodoItem = { content: string; activeForm: string; status: TodoStatus };
const TODO_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

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
    name: "ask_user_question",
    description:
      "Ask the human a question and wait for their answer. Provide `options` for a multiple-choice prompt. Returns an unanswered status when there is no interactive terminal.",
    requiredPermission: "read-only",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional choices to present as a numbered list.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "enter_plan_mode",
    description:
      "Enter plan mode: write/edit/run tools are blocked until exit_plan_mode applies a plan. Use while researching before making changes.",
    requiredPermission: "read-only",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "exit_plan_mode",
    description:
      "Present the proposed plan for approval and leave plan mode. On approval, edits are re-enabled; without a terminal the plan is auto-approved.",
    requiredPermission: "read-only",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        plan: { type: "string" },
      },
      required: ["plan"],
    },
  },
  {
    name: "todo_write",
    description:
      "Record the task todo list. Each item needs `content`, `activeForm`, and a status of pending|in_progress|completed. Submitting an all-completed list clears the store.",
    requiredPermission: "read-only",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              content: { type: "string" },
              activeForm: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "activeForm", "status"],
          },
        },
      },
      required: ["todos"],
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
    case "ask_user_question": {
      const question = requireString(args.question, "question");
      const options = arrayOfStrings(args.options);

      if (!context.interaction) {
        return {
          toolName: name,
          content: prettyJson({
            question,
            answer: null,
            status: "unanswered",
            reason: "no interactive terminal",
          }),
        };
      }

      const answer = options.length > 0
        ? await context.interaction.askChoice(question, options)
        : await context.interaction.askText(question);
      return {
        toolName: name,
        content: prettyJson({ question, answer, status: "answered" }),
      };
    }
    case "enter_plan_mode": {
      if (!context.planMode) {
        return {
          toolName: name,
          content: prettyJson({
            active: false,
            changed: false,
            message: "Plan mode unavailable in this context.",
          }),
        };
      }

      const wasActive = context.planMode.active;
      context.planMode.active = true;
      return {
        toolName: name,
        content: prettyJson({
          active: true,
          changed: !wasActive,
          message: "Plan mode on: edits are blocked until exit_plan_mode.",
        }),
      };
    }
    case "exit_plan_mode": {
      const plan = requireString(args.plan, "plan");

      if (!context.planMode?.active) {
        return {
          toolName: name,
          content: prettyJson({
            active: false,
            approved: true,
            changed: false,
            message: "Not in plan mode.",
          }),
        };
      }

      if (!context.interaction) {
        context.planMode.active = false;
        return {
          toolName: name,
          content: prettyJson({
            active: false,
            approved: true,
            changed: true,
            autoApproved: true,
            message: "No TTY; plan auto-approved.",
          }),
        };
      }

      const ok = await context.interaction.askYesNo(`Proceed with this plan?\n\n${plan}`);
      if (ok) {
        context.planMode.active = false;
        return {
          toolName: name,
          content: prettyJson({
            active: false,
            approved: true,
            changed: true,
            message: "Plan approved; edits enabled.",
          }),
        };
      }

      return {
        toolName: name,
        content: prettyJson({
          active: true,
          approved: false,
          changed: false,
          message: "Plan rejected; still in plan mode.",
        }),
      };
    }
    case "todo_write": {
      const todos = parseTodos(args.todos);
      if (typeof todos === "string") {
        return { toolName: name, content: todos };
      }

      const storePath = todoStorePath(context.root);
      const oldTodos = readTodoStore(storePath);
      const allCompleted = todos.every((todo) => todo.status === "completed");
      const newTodos = allCompleted ? [] : todos;
      writeTodoStore(storePath, newTodos);

      const verificationNudgeNeeded =
        allCompleted && todos.length >= 3 && !todos.some((todo) => /verif/i.test(todo.content))
          ? true
          : undefined;
      return {
        toolName: name,
        content: prettyJson({ oldTodos, newTodos, verificationNudgeNeeded }),
      };
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

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Validate the `todos` argument. Returns the parsed list, or an `ERROR: ...`
 * string describing the first violation (so the loop can continue).
 */
function parseTodos(value: unknown): TodoItem[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return "ERROR: todos must be a non-empty array.";
  }

  const todos: TodoItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `ERROR: todos[${index}] must be an object.`;
    }

    const { content, activeForm, status } = item as Record<string, unknown>;
    if (typeof content !== "string" || content.length === 0) {
      return `ERROR: todos[${index}].content must be a non-empty string.`;
    }
    if (typeof activeForm !== "string" || activeForm.length === 0) {
      return `ERROR: todos[${index}].activeForm must be a non-empty string.`;
    }
    if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoStatus)) {
      return `ERROR: todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}.`;
    }

    todos.push({ content, activeForm, status: status as TodoStatus });
  }

  return todos;
}

function todoStorePath(root: string): string {
  return process.env.SOLARCIDO_TODO_STORE || path.join(root, ".solarcido-todos.json");
}

function readTodoStore(storePath: string): TodoItem[] {
  if (!existsSync(storePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed as TodoItem[] : [];
  } catch {
    return [];
  }
}

function writeTodoStore(storePath: string, todos: TodoItem[]): void {
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(todos, null, 2)}\n`, "utf8");
}
