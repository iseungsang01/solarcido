import { v4 as uuidv4 } from "uuid";
import type { Session } from "./session-store-types.js";

/**
 * In-memory session store for the CLI.
 * This is a simple implementation for development; production could replace with a DB.
 */
export const sessionStore = {
  sessions: new Map<string, Session>(),
  nextId: 1,

  /**
   * Create a new session.
   */
  async createSession(sessionData: {
    goal: string;
    cwd: string;
    model: string;
    reasoningEffort: any;
    approvalPolicy: string;
    sandbox: string;
  }): Promise<Session> {
    const id = uuidv4();
    const session: Session = {
      id,
      goal: sessionData.goal,
      cwd: sessionData.cwd,
      model: sessionData.model,
      reasoningEffort: sessionData.reasoningEffort,
      approvalPolicy: sessionData.approvalPolicy,
      sandbox: sessionData.sandbox,
      status: "pending",
      summary: "",
      changedFiles: [],
      nextSteps: [],
      transcript: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  },

  /**
   * Update session status and store final results.
   */
  async completeSession(session: Session, result: {
    summary: string;
    changedFiles: string[];
    nextSteps: string[];
  }): Promise<void> {
    session.status = "completed";
    session.summary = result.summary;
    session.changedFiles = result.changedFiles;
    session.nextSteps = result.nextSteps;
    session.updatedAt = new Date().toISOString();
  },

  /**
   * Mark session as failed.
   */
  async failSession(session: Session, error: string): Promise<void> {
    session.status = "failed";
    session.summary = error;
    session.updatedAt = new Date().toISOString();
  },

  /**
   * List all sessions.
   */
  async listSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values());
  },

  /**
   * Read a session by id.
   */
  async readSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  },
};
