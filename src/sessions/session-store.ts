import { promises as fs } from "node:fs";
import path from "node:path";

import { getSolarcidoHome } from "../config/load-config.js";
import type { ApprovalPolicy, SandboxMode } from "../config/schema.js";
import type { ReasoningEffort } from "../solar/constants.js";

export type SessionStatus = "running" | "completed" | "failed";

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  goal: string;
  cwd: string;
  model?: string;
  reasoningEffort: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  summary?: string;
  changedFiles: string[];
  nextSteps: string[];
  error?: string;
};

export type CreateSessionOptions = {
  goal: string;
  cwd: string;
  model?: string;
  reasoningEffort: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
};

export function getSessionsDir(): string {
  return path.join(getSolarcidoHome(), "sessions");
}

export async function createSession(options: CreateSessionOptions): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    id: createSessionId(now),
    createdAt: now,
    updatedAt: now,
    status: "running",
    goal: options.goal,
    cwd: options.cwd,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    changedFiles: [],
    nextSteps: [],
  };

  await writeSession(record);
  return record;
}

export async function completeSession(
  session: SessionRecord,
  update: { summary: string; changedFiles: string[]; nextSteps: string[] },
): Promise<SessionRecord> {
  const { error: _error, ...sessionWithoutError } = session;
  const record: SessionRecord = {
    ...sessionWithoutError,
    updatedAt: new Date().toISOString(),
    status: "completed",
    summary: update.summary,
    changedFiles: update.changedFiles,
    nextSteps: update.nextSteps,
  };

  await writeSession(record);
  return record;
}

export async function failSession(session: SessionRecord, error: string): Promise<SessionRecord> {
  const record: SessionRecord = {
    ...session,
    updatedAt: new Date().toISOString(),
    status: "failed",
    error,
  };

  await writeSession(record);
  return record;
}

export async function listSessions(): Promise<SessionRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getSessionsDir());
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readSession(entry.slice(0, -".json".length))),
  );

  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readSession(id: string): Promise<SessionRecord> {
  const content = await fs.readFile(sessionPath(id), "utf8");
  return JSON.parse(content) as SessionRecord;
}

async function writeSession(record: SessionRecord): Promise<void> {
  await fs.mkdir(getSessionsDir(), { recursive: true });
  await fs.writeFile(sessionPath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function sessionPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.json`);
}

function createSessionId(isoDate: string): string {
  const timestamp = isoDate.replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
