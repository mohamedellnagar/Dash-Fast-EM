import { prisma } from '../db/prisma';
import { hashPassword } from './auth.service';

// ---- User & Access management (RBAC admin) ----
// All roles/permissions are already modelled; this service is the admin surface
// for managing which users exist, their roles, activation, and school scoping.

export interface NewUser {
  email: string;
  fullName: string;
  password: string;
  roleKeys: string[];
  schoolIds?: string[];
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      userRoles: { include: { role: true } },
      schoolScopes: { select: { schoolId: true } },
    },
  });
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roleKeys: u.userRoles.map((r) => r.role.key),
    roleNames: u.userRoles.map((r) => r.role.name),
    schoolIds: u.schoolScopes.map((s) => s.schoolId),
    schoolScopeCount: u.schoolScopes.length,
  }));
}

/** Roles with permission + user counts (grants read from DB), for pickers. */
export async function listRoles() {
  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { userRoles: true } },
      rolePermissions: { include: { permission: true } },
    },
  });
  return roles.map((r) => {
    const permissions = r.rolePermissions.map((rp) => rp.permission.key);
    return { id: r.id, key: r.key, name: r.name, userCount: r._count.userRoles, permissionCount: permissions.length, permissions };
  });
}

export async function getUser(id: string) {
  const u = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: { userRoles: true, schoolScopes: true },
  });
  if (!u) return null;
  return {
    id: u.id, email: u.email, fullName: u.fullName, isActive: u.isActive,
    roleIds: u.userRoles.map((r) => r.roleId),
    schoolIds: u.schoolScopes.map((s) => s.schoolId),
  };
}

async function roleIdsForKeys(roleKeys: string[]): Promise<string[]> {
  if (!roleKeys.length) return [];
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } }, select: { id: true } });
  return roles.map((r) => r.id);
}

export async function createUser(data: NewUser) {
  const email = data.email.trim().toLowerCase();
  if (!email || !data.fullName.trim()) throw new Error('Email and full name are required');
  if (!data.password || data.password.length < 8) throw new Error('Password must be at least 8 characters');
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error('A user with this email already exists');

  const roleIds = await roleIdsForKeys(data.roleKeys);
  const passwordHash = await hashPassword(data.password);
  return prisma.user.create({
    data: {
      email, fullName: data.fullName.trim(), passwordHash, isActive: true,
      userRoles: { create: roleIds.map((roleId) => ({ roleId })) },
      schoolScopes: data.schoolIds?.length ? { create: data.schoolIds.map((schoolId) => ({ schoolId })) } : undefined,
    },
  });
}

/** Replace a user's roles + school scopes atomically. */
export async function updateUserAccess(id: string, roleKeys: string[], schoolIds: string[]) {
  const roleIds = await roleIdsForKeys(roleKeys);
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId: id } }),
    prisma.userSchoolScope.deleteMany({ where: { userId: id } }),
    ...(roleIds.length ? [prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) })] : []),
    ...(schoolIds.length ? [prisma.userSchoolScope.createMany({ data: schoolIds.map((schoolId) => ({ userId: id, schoolId })) })] : []),
  ]);
}

export async function updateProfile(id: string, fullName: string) {
  await prisma.user.update({ where: { id }, data: { fullName: fullName.trim() } });
}

export async function setActive(id: string, isActive: boolean) {
  await prisma.user.update({ where: { id }, data: { isActive } });
}

export async function resetPassword(id: string, password: string) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
}

/** Soft-delete (keeps audit history intact). */
export async function deleteUser(id: string) {
  await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
}
