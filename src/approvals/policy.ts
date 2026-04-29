import type { ApprovalPolicy } from "../config/schema.js";

export type CommandRisk = "low" | "risky";

export type ApprovalDecision =
  | {
      approved: true;
    }
  | {
      approved: false;
      reason: string;
    };

export function decideApproval(policy: ApprovalPolicy, risk: CommandRisk, approvedByUser: boolean | undefined): ApprovalDecision {
  if (policy === "never") {
    return { approved: true };
  }

  if (policy === "on-failure") {
    return { approved: true };
  }

  if (risk === "low") {
    return { approved: true };
  }

  if (approvedByUser) {
    return { approved: true };
  }

  return {
    approved: false,
    reason: "Command requires approval.",
  };
}
