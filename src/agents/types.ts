export type AgentRole =
  | "planner"
  | "explorer"
  | "executor"
  | "verifier"
  | "reviewer";

export type AgentResult = {
  role: AgentRole;
  summary: string;
  findings: string[];
  changedFiles: string[];
  evidence: string[];
  risks: string[];
  nextSteps: string[];
};

export type WorkflowPlan = {
  summary: string;
  requiresModification: boolean;
  explorationTargets: string[];
  executionSteps: string[];
  verificationCommands: string[];
};

export type OrchestrationResult = {
  summary: string;
  changedFiles: string[];
  nextSteps: string[];
  agentResults: AgentResult[];
};