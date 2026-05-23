export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

const PERMISSION_RANK: Record<PermissionMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

export function permissionAllows(maxPermission: PermissionMode, requiredPermission: PermissionMode): boolean {
  return PERMISSION_RANK[requiredPermission] <= PERMISSION_RANK[maxPermission];
}
