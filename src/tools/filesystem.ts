import { promises as fs } from "node:fs";
import path from "node:path";

type ToolResult = {
  ok: boolean;
  output: string;
};

const DEFAULT_SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const MAX_FILE_BYTES = 1024 * 1024;

function resolveInsideRoot(root: string, target = "."): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the working directory: ${target}`);
  }

  return resolved;
}

async function walkDirectory(dir: string, depth: number, includeHidden: boolean, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    if (entry.isDirectory() && DEFAULT_SKIPPED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = fullPath;
    const label = entry.isDirectory() ? `${relativePath}/` : relativePath;
    lines.push(label);

    if (entry.isDirectory() && currentDepth < depth) {
      const children = await walkDirectory(fullPath, depth, includeHidden, currentDepth + 1);
      lines.push(...children);
    }
  }

  return lines;
}

async function collectFiles(dir: string, depth: number, includeHidden: boolean, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    if (entry.isDirectory() && DEFAULT_SKIPPED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, depth, includeHidden, currentDepth + 1)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeLineWindow(totalLines: number, offset = 1, limit?: number): { start: number; end: number } {
  const start = Math.max(1, Math.floor(offset));
  const cappedLimit = limit === undefined ? totalLines : Math.max(1, Math.floor(limit));
  const end = Math.min(totalLines, start + cappedLimit - 1);
  return { start, end };
}

function withLineNumbers(content: string, offset?: number, limit?: number): string {
  const lines = content.split(/\r?\n/);
  const { start, end } = normalizeLineWindow(lines.length, offset, limit);
  const width = String(end).length;

  return lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(width, " ")} | ${line}`)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegex(pattern: string, caseSensitive: boolean, regex: boolean): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  return new RegExp(regex ? pattern : escapeRegExp(pattern), flags);
}

export async function listFiles(root: string, targetPath = ".", depth = 2, includeHidden = false): Promise<ToolResult> {
  const resolved = resolveInsideRoot(root, targetPath);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }

  const rows = await walkDirectory(resolved, depth, includeHidden);
  const relativeRows = rows.map((entry) => path.relative(root, entry.replace(/\/$/, "")) + (entry.endsWith("/") ? "/" : ""));

  return {
    ok: true,
    output: relativeRows.join("\n") || "<empty directory>",
  };
}

export async function readFile(root: string, targetPath: string, offset?: number, limit?: number): Promise<ToolResult> {
  const resolved = resolveInsideRoot(root, targetPath);
  const stat = await fs.stat(resolved);

  if (stat.size > MAX_FILE_BYTES && limit === undefined) {
    throw new Error(`File is large (${stat.size} bytes). Read it with offset and limit.`);
  }

  const content = await fs.readFile(resolved, "utf8");

  return {
    ok: true,
    output: offset !== undefined || limit !== undefined ? withLineNumbers(content, offset, limit) : content,
  };
}

export async function writeFile(root: string, targetPath: string, content: string): Promise<ToolResult> {
  const resolved = resolveInsideRoot(root, targetPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");

  return {
    ok: true,
    output: `Wrote ${path.relative(root, resolved)}`,
  };
}

export async function editFile(
  root: string,
  targetPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<ToolResult> {
  if (!oldString) {
    throw new Error("old_string must not be empty.");
  }

  const resolved = resolveInsideRoot(root, targetPath);
  const content = await fs.readFile(resolved, "utf8");
  const matches = content.split(oldString).length - 1;

  if (matches === 0) {
    throw new Error(`Could not find old_string in ${targetPath}.`);
  }

  if (matches > 1 && !replaceAll) {
    throw new Error(`old_string appears ${matches} times in ${targetPath}; set replace_all true or provide more context.`);
  }

  const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  await fs.writeFile(resolved, updated, "utf8");

  return {
    ok: true,
    output: `Edited ${path.relative(root, resolved)} (${replaceAll ? matches : 1} replacement${matches === 1 ? "" : "s"})`,
  };
}

export async function searchFiles(
  root: string,
  pattern: string,
  targetPath = ".",
  maxResults = 100,
  caseSensitive = false,
  regex = false,
): Promise<ToolResult> {
  if (!pattern) {
    throw new Error("pattern is required.");
  }

  const resolved = resolveInsideRoot(root, targetPath);
  const stat = await fs.stat(resolved);
  const files = stat.isDirectory() ? await collectFiles(resolved, 25, false) : [resolved];
  const searchRegex = buildSearchRegex(pattern, caseSensitive, regex);
  const rows: string[] = [];

  for (const file of files) {
    if (rows.length >= maxResults) {
      break;
    }

    const fileStat = await fs.stat(file);
    if (fileStat.size > MAX_FILE_BYTES) {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && rows.length < maxResults; index += 1) {
      searchRegex.lastIndex = 0;
      if (searchRegex.test(lines[index])) {
        rows.push(`${path.relative(root, file)}:${index + 1}: ${lines[index]}`);
      }
    }
  }

  return {
    ok: true,
    output: rows.join("\n") || "<no matches>",
  };
}
