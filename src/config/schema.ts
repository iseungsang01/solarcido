import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "../solar/constants.js";

export type ApprovalPolicy = "never" | "on-failure" | "on-request";
export type SandboxMode = "read-only" | "workspace-write";

export type SolarcidoConfig = {
  model: string;
  reasoningEffort: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  quiet: boolean;
};

export const DEFAULT_CONFIG: SolarcidoConfig = {
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  approvalPolicy: "on-failure",
  sandbox: "workspace-write",
  quiet: false,
};

export const CONFIG_KEYS = [
  "model",
  "reasoningEffort",
  "approvalPolicy",
  "sandbox",
  "quiet",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}
