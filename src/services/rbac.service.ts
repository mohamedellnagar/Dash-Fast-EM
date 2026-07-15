import { prisma } from '../db/prisma';
import { PERMISSION, ROLE, RoleKey, PermissionKey } from '../lib/enums';

// Default role → permission grants. Seeded into the DB; this map is the source
// of truth used by the seed script and by RBAC tests.
export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  [ROLE.ADMINISTRATOR]: Object.values(PERMISSION),
  [ROLE.OPERATIONS]: [
    PERMISSION.DASHBOARD_VIEW,
    PERMISSION.MONITORING_VIEW,
    PERMISSION.STUDENT_VIEW,
    PERMISSION.RESULTS_VIEW,
    PERMISSION.EXPORT_RUN,
    PERMISSION.MANUAL_SYNC,
    PERMISSION.API_MONITORING_VIEW,
    PERMISSION.ATTENTION_VIEW,
    PERMISSION.ATTENTION_MANAGE,
    // Phase 3 — operators run the sync platform (not sync:admin).
    PERMISSION.SYNC_VIEW,
    PERMISSION.SYNC_BULK,
    PERMISSION.SYNC_CANCEL,
    PERMISSION.SYNC_RETRY,
    PERMISSION.QUEUE_VIEW,
    PERMISSION.QUEUE_MANAGE,
    PERMISSION.WORKER_VIEW,
    PERMISSION.WORKSPACE_PAUSE,
    PERMISSION.ALERT_VIEW,
    PERMISSION.ALERT_MANAGE,
  ],
  [ROLE.ASSESSMENT_TEAM]: [
    PERMISSION.DASHBOARD_VIEW,
    PERMISSION.MONITORING_VIEW,
    PERMISSION.STUDENT_VIEW,
    PERMISSION.RESULTS_VIEW,
    PERMISSION.EXPORT_RUN,
    PERMISSION.ATTENTION_VIEW,
    PERMISSION.PII_UNMASK,
    // read-only observability
    PERMISSION.SYNC_VIEW,
    PERMISSION.QUEUE_VIEW,
    PERMISSION.ALERT_VIEW,
  ],
  [ROLE.SCHOOL_USER]: [
    PERMISSION.DASHBOARD_VIEW,
    PERMISSION.MONITORING_VIEW,
    PERMISSION.STUDENT_VIEW,
  ],
  [ROLE.VIEWER]: [PERMISSION.DASHBOARD_VIEW, PERMISSION.MONITORING_VIEW],
};

export interface AuthPrincipal {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  schoolScopeIds: string[]; // empty means unrestricted (unless SCHOOL_USER)
  isSchoolScoped: boolean;
}

/** Load a full principal (roles, permissions, school scopes) for a user id. */
export async function loadPrincipal(userId: string): Promise<AuthPrincipal | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } },
      schoolScopes: true,
    },
  });
  if (!user) return null;

  const roles = user.userRoles.map((ur) => ur.role.key);
  const permissions = new Set<string>();
  for (const ur of user.userRoles) {
    for (const rp of ur.role.rolePermissions) permissions.add(rp.permission.key);
  }
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    roles,
    permissions,
    schoolScopeIds: user.schoolScopes.map((s) => s.schoolId),
    isSchoolScoped: roles.includes(ROLE.SCHOOL_USER),
  };
}

export function hasPermission(principal: AuthPrincipal, permission: PermissionKey): boolean {
  return principal.permissions.has(permission);
}
