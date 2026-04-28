import { promises as fs } from "node:fs";
import path from "node:path";

type ToolResult = {
  ok: boolean;
  output: string;
};

function resolveInsideRoot(root: string, target = "."): string {
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the working directory: ${target}`);
  }

  return resolved;
}

async function walkDirectory(dir: string, depth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth > depth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = fullPath;
    const label = entry.isDirectory() ? `${relativePath}/` : relativePath;
    lines.push(label);

    if (entry.isDirectory() && currentDepth < depth) {
      const children = await walkDirectory(fullPath, depth, currentDepth + 1);
      lines.push(...children);
    }
  }

  return lines;
}

export async function listFiles(root: string, targetPath = ".", depth = 2): Promise<ToolResult> {
  const resolved = resolveInsideRoot(root, targetPath);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }

  const rows = await walkDirectory(resolved, depth);
  const relativeRows = rows.map((entry) => path.relative(root, entry.replace(/\/$/, "")) + (entry.endsWith("/") ? "/" : ""));

  return {
    ok: true,
    output: relativeRows.join("\n") || "<empty directory>",
  };
}

export async function readFile(root: string, targetPath: string): Promise<ToolResult> {
  const resolved = resolveInsideRoot(root, targetPath);
  const content = await fs.readFile(resolved, "utf8");

  return {
    ok: true,
    output: content,
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
