import type { ApprovalPolicy, SandboxMode } from "./config.js";
import { permissionAllows, type PermissionMode } from "./permissions.js";

export type CommandRisk = "low" | "risky";

export type PermissionDecision =
  | {
      approved: true;
    }
  | {
      approved: false;
      reason: string;
    };

export type PermissionPolicy = {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  maxPermission?: PermissionMode;
  approveCommand?: (command: string) => Promise<boolean>;
};

const RISKY_COMMAND_PATTERNS = [
  /\brm\b/i,
  /\bdel\b/i,
  /\bremove-item\b/i,
  /\brmdir\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+checkout\b/i,
  /\bnpm\s+(install|publish)\b/i,
  /\bnpm\.cmd\s+(install|publish)\b/i,
  /\byarn\s+(add|remove|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish)\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\binvoke-webrequest\b/i,
  /\bset-executionpolicy\b/i,
  /\bsudo\b/i,
];

export class PermissionEnforcer {
  constructor(private readonly policy: PermissionPolicy) {}

  withPolicy(policy: Omit<PermissionPolicy, "approveCommand">): PermissionEnforcer {
    return new PermissionEnforcer({
      ...this.policy,
      ...policy,
    });
  }

  decideTool(toolPermission: PermissionMode, toolName = "tool"): PermissionDecision {
    const maxPermission = this.policy.maxPermission ?? this.policy.sandbox;
    if (permissionAllows(maxPermission, toolPermission)) {
      return { approved: true };
    }

    if (maxPermission === "read-only" && toolPermission === "workspace-write") {
      return {
        approved: false,
        reason: `${toolName} is disabled in read-only sandbox mode.`,
      };
    }

    return {
      approved: false,
      reason: `${toolName} requires ${toolPermission} permission, but current permission is ${maxPermission}.`,
    };
  }

  async decideCommand(command: string): Promise<PermissionDecision> {
    const risk = classifyCommand(command);
    if (this.policy.approvalPolicy === "never" || this.policy.approvalPolicy === "on-failure" || risk === "low") {
      return { approved: true };
    }

    const approvedByUser = this.policy.approveCommand ? await this.policy.approveCommand(command) : false;
    return decideApproval(this.policy.approvalPolicy, risk, approvedByUser);
  }
}

export function classifyCommand(command: string): CommandRisk {
  return RISKY_COMMAND_PATTERNS.some((pattern) => pattern.test(command)) ? "risky" : "low";
}

export function decideApproval(
  policy: ApprovalPolicy,
  risk: CommandRisk,
  approvedByUser: boolean | undefined,
): PermissionDecision {
  if (policy === "never" || policy === "on-failure" || risk === "low" || approvedByUser) {
    return { approved: true };
  }

  return {
    approved: false,
    reason: "Command requires approval.",
  };
}
