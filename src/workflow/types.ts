export type OrchestrationResult = {
  summary: string;
  changedFiles: string[];
  nextSteps: string[];
  agentResults: any[]; // each agent result can be any shape; we'll use AgentResult from agents/types
};

export type WorkflowPlan = {
  summary: string;
  requiresModification: boolean;
  explorationTargets: string[];
  executionSteps: string[];
  verificationCommands: string[];
};

export type AgentResult = {
  role: string;
  summary: string;
  findings: string[];
  changedFiles: string[];
  evidence: string[];
  risks: string[];
  nextSteps: string[];
};

export type ExecutionResult = {
  finish: any;
  transcript: string[];
};

export type FinishPayload = {
  summary: string;
  changed_files: string[];
  next_steps: string[];
};

export type VerificationResult = {
  role: string;
  summary: string;
  findings: string[];
  changedFiles: string[];
  evidence: string[];
  risks: string[];
  nextSteps: string[];
};
