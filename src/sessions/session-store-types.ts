export interface Session {
  id: string;
  goal: string;
  cwd: string;
  model: string;
  reasoningEffort: any;
  approvalPolicy: string;
  sandbox: string;
  status: "pending" | "completed" | "failed";
  summary: string;
  changedFiles: string[];
  nextSteps: string[];
  transcript: string[];
  createdAt: string;
  updatedAt: string;
}
