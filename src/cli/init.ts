/**
 * `solarcido init` / `/init` — scaffold project guidance for the assistant.
 * Ported and adapted from claw-rust rusty-claude-cli/src/init.rs for Solarcido's
 * conventions (CLAUDE.md + .gitignore; sessions live under ~/.solarcido, not the
 * repo, so no session entries are written here). Idempotent.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type InitStatus = "created" | "updated" | "skipped";

export type InitArtifact = { name: string; status: InitStatus };

export type InitReport = { projectRoot: string; artifacts: InitArtifact[] };

export type StackDetection = {
  node: boolean;
  typescript: boolean;
  rust: boolean;
  python: boolean;
  go: boolean;
};

const GITIGNORE_COMMENT = "# Solarcido / local secrets";
const GITIGNORE_ENTRIES = [".env"] as const;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function detectStack(cwd: string): Promise<StackDetection> {
  const [node, typescript, rust, python, pyreq, go] = await Promise.all([
    exists(path.join(cwd, "package.json")),
    exists(path.join(cwd, "tsconfig.json")),
    exists(path.join(cwd, "Cargo.toml")),
    exists(path.join(cwd, "pyproject.toml")),
    exists(path.join(cwd, "requirements.txt")),
    exists(path.join(cwd, "go.mod")),
  ]);
  return { node, typescript, rust, python: python || pyreq, go };
}

function renderStackLine(stack: StackDetection): string {
  const langs: string[] = [];
  if (stack.typescript) langs.push("TypeScript");
  else if (stack.node) langs.push("JavaScript/Node");
  if (stack.rust) langs.push("Rust");
  if (stack.python) langs.push("Python");
  if (stack.go) langs.push("Go");
  return langs.length > 0 ? langs.join(", ") : "none detected";
}

function renderClaudeMd(stack: StackDetection): string {
  return [
    "# CLAUDE.md",
    "",
    "This file provides guidance to coding assistants working in this repository.",
    "",
    "## Detected stack",
    `- Languages: ${renderStackLine(stack)}.`,
    "",
    "## Working agreement",
    "- Prefer small, reviewable changes; keep edits scoped to the task.",
    "- Run the project's build/test/lint before claiming a change is complete.",
    "- Do not commit secrets; keep credentials in a git-ignored `.env`.",
    "",
  ].join("\n");
}

async function writeClaudeMd(cwd: string, stack: StackDetection): Promise<InitStatus> {
  const target = path.join(cwd, "CLAUDE.md");
  if (await exists(target)) {
    return "skipped";
  }
  await fs.writeFile(target, renderClaudeMd(stack), "utf8");
  return "created";
}

async function ensureGitignore(cwd: string): Promise<InitStatus> {
  const target = path.join(cwd, ".gitignore");

  if (!(await exists(target))) {
    await fs.writeFile(target, `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRIES.join("\n")}\n`, "utf8");
    return "created";
  }

  const current = await fs.readFile(target, "utf8");
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    return "skipped";
  }

  const prefix = current.endsWith("\n") || current === "" ? "" : "\n";
  await fs.appendFile(target, `${prefix}${GITIGNORE_COMMENT}\n${missing.join("\n")}\n`, "utf8");
  return "updated";
}

export async function initializeRepo(cwd: string): Promise<InitReport> {
  const stack = await detectStack(cwd);
  const artifacts: InitArtifact[] = [
    { name: "CLAUDE.md", status: await writeClaudeMd(cwd, stack) },
    { name: ".gitignore", status: await ensureGitignore(cwd) },
  ];
  return { projectRoot: path.resolve(cwd), artifacts };
}

export function formatInitReport(report: InitReport): string {
  const lines = ["Init", `  Project          ${report.projectRoot}`];
  for (const artifact of report.artifacts) {
    lines.push(`  ${artifact.name.padEnd(16)} ${artifact.status}`);
  }
  lines.push("  Next step        Review and tailor the generated guidance");
  return lines.join("\n");
}
