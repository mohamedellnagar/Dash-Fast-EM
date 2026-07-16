import { prisma } from '../db/prisma';
import { PERMISSION, ROLE } from '../lib/enums';

// ---- Role & Permission management (DB-driven, editable) ----
// Permissions are resolved from the DB (RolePermission) at login, so edits here
// take effect on the user's next request. The Administrator role is protected:
// it always holds every permission and cannot be edited or deleted.

const BUILTIN_ROLE_KEYS = Object.values(ROLE) as string[];

/** The full catalog of permission keys the app understands. */
export function permissionCatalog(): string[] {
  return Object.values(PERMISSION);
}

/** Permissions grouped by their prefix (e.g. "dashboard", "sync") for the UI. */
export function permissionGroups(): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const key of permissionCatalog()) {
    const group = key.includes(':') ? key.split(':')[0] : 'other';
    (groups[group] ??= []).push(key);
  }
  return groups;
}

export async function rolesWithGrants() {
  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    include: {
      rolePermissions: { include: { permission: true } },
      _count: { select: { userRoles: true } },
    },
  });
  return roles.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    userCount: r._count.userRoles,
    builtIn: BUILTIN_ROLE_KEYS.includes(r.key),
    locked: r.key === ROLE.ADMINISTRATOR, // full access, not editable
    permissionKeys: r.rolePermissions.map((rp) => rp.permission.key),
  }));
}

export async function setRolePermissions(roleId: string, permissionKeys: string[]): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new Error('Role not found');
  if (role.key === ROLE.ADMINISTRATOR) throw new Error('The Administrator role always has full access and cannot be edited');
  const valid = new Set(permissionCatalog());
  const perms = await prisma.permission.findMany({ where: { key: { in: permissionKeys.filter((k) => valid.has(k)) } }, select: { id: true } });
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    ...(perms.length ? [prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) })] : []),
  ]);
}

export async function createRole(data: { key: string; name: string; description?: string }) {
  const key = data.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!key || !data.name.trim()) throw new Error('Key and name are required');
  const existing = await prisma.role.findUnique({ where: { key } });
  if (existing) throw new Error('A role with this key already exists');
  return prisma.role.create({ data: { key, name: data.name.trim(), description: data.description?.trim() || null } });
}

export async function updateRoleMeta(roleId: string, name: string, description?: string): Promise<void> {
  await prisma.role.update({ where: { id: roleId }, data: { name: name.trim(), description: description?.trim() || null } });
}

export async function deleteRole(roleId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, include: { _count: { select: { userRoles: true } } } });
  if (!role) throw new Error('Role not found');
  if (BUILTIN_ROLE_KEYS.includes(role.key)) throw new Error('Built-in roles cannot be deleted');
  if (role._count.userRoles > 0) throw new Error('Reassign the users on this role before deleting it');
  await prisma.role.delete({ where: { id: roleId } });
}
