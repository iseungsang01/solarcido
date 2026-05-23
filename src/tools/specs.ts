import type { PermissionMode } from "../runtime/permissions.js";

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermission: PermissionMode;
};

