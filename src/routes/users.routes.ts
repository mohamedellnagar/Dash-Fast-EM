import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit.service';
import { asyncHandler } from '../middleware/async-handler';
import * as users from '../services/users.service';
import * as rolesSvc from '../services/roles.service';

export const usersRouter = Router();

const manage = [requireAuth, requirePermission(PERMISSION.USER_MANAGE)];
function actor(req: any) {
  return { userId: req.principal.userId, actorEmail: req.principal.email, ipAddress: req.ip };
}
const toArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

// ---- Page ----
usersRouter.get('/admin/users', manage, asyncHandler(async (req, res) => {
  const [userList, roles, schools] = await Promise.all([
    users.listUsers(),
    users.listRoles(),
    prisma.school.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  res.render('users', {
    title: 'User & Access Management', principal: req.principal, nav: 'users',
    users: userList, roles, schools, currentUserId: req.principal!.userId,
    msg: req.query.msg ?? null, err: req.query.err ?? null,
  });
}));

// ---- Create ----
const createSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(160),
  password: z.string().min(8).max(200),
});
usersRouter.post('/admin/users', manage, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/users?err=' + encodeURIComponent('Email, name and a password (8+ chars) are required'));
  try {
    const u = await users.createUser({ ...parsed.data, roleKeys: toArray(req.body.roleKeys), schoolIds: toArray(req.body.schoolIds) });
    await audit({ ...actor(req), action: 'USER_CREATE', entityType: 'User', entityId: u.id, detail: `created ${u.email}` });
    res.redirect('/admin/users?msg=' + encodeURIComponent('User created'));
  } catch (e) {
    res.redirect('/admin/users?err=' + encodeURIComponent((e as Error).message));
  }
}));

// ---- Update roles + school scope ----
usersRouter.post('/admin/users/:id/access', manage, asyncHandler(async (req, res) => {
  const roleKeys = toArray(req.body.roleKeys);
  // Guard: don't let an admin strip their own administrator access (self-lockout).
  if (req.params.id === req.principal!.userId && !roleKeys.includes('ADMINISTRATOR')) {
    return res.redirect('/admin/users?err=' + encodeURIComponent('You cannot remove your own Administrator role'));
  }
  await users.updateUserAccess(req.params.id, roleKeys, toArray(req.body.schoolIds));
  await audit({ ...actor(req), action: 'USER_ACCESS_UPDATE', entityType: 'User', entityId: req.params.id, detail: `roles=${roleKeys.join(',')}` });
  res.redirect('/admin/users?msg=' + encodeURIComponent('Access updated'));
}));

// ---- Rename ----
usersRouter.post('/admin/users/:id/profile', manage, asyncHandler(async (req, res) => {
  const name = String(req.body.fullName ?? '').trim();
  if (name) { await users.updateProfile(req.params.id, name); await audit({ ...actor(req), action: 'USER_UPDATE', entityType: 'User', entityId: req.params.id, detail: 'renamed' }); }
  res.redirect('/admin/users?msg=' + encodeURIComponent('Saved'));
}));

// ---- Activate / deactivate ----
usersRouter.post('/admin/users/:id/active', manage, asyncHandler(async (req, res) => {
  const isActive = req.body.active === 'true' || req.body.active === true;
  if (req.params.id === req.principal!.userId && !isActive) {
    return res.redirect('/admin/users?err=' + encodeURIComponent('You cannot deactivate your own account'));
  }
  await users.setActive(req.params.id, isActive);
  await audit({ ...actor(req), action: isActive ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', entityType: 'User', entityId: req.params.id });
  res.redirect('/admin/users?msg=' + encodeURIComponent(isActive ? 'User activated' : 'User deactivated'));
}));

// ---- Reset password ----
usersRouter.post('/admin/users/:id/password', manage, asyncHandler(async (req, res) => {
  try {
    await users.resetPassword(req.params.id, String(req.body.password ?? ''));
    await audit({ ...actor(req), action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: req.params.id });
    res.redirect('/admin/users?msg=' + encodeURIComponent('Password reset'));
  } catch (e) {
    res.redirect('/admin/users?err=' + encodeURIComponent((e as Error).message));
  }
}));

// ======== Roles & Permissions management ========
usersRouter.get('/admin/roles', manage, asyncHandler(async (req, res) => {
  res.render('roles', {
    title: 'Roles & Permissions', principal: req.principal, nav: 'roles',
    roles: await rolesSvc.rolesWithGrants(), groups: rolesSvc.permissionGroups(),
    msg: req.query.msg ?? null, err: req.query.err ?? null,
  });
}));

usersRouter.post('/admin/roles', manage, asyncHandler(async (req, res) => {
  try {
    const r = await rolesSvc.createRole({ key: String(req.body.key ?? ''), name: String(req.body.name ?? ''), description: String(req.body.description ?? '') });
    await audit({ ...actor(req), action: 'ROLE_CREATE', entityType: 'Role', entityId: r.id, detail: r.key });
    res.redirect('/admin/roles?msg=' + encodeURIComponent('Role created'));
  } catch (e) { res.redirect('/admin/roles?err=' + encodeURIComponent((e as Error).message)); }
}));

usersRouter.post('/admin/roles/:id/permissions', manage, asyncHandler(async (req, res) => {
  try {
    await rolesSvc.setRolePermissions(req.params.id, toArray(req.body.permissionKeys));
    await audit({ ...actor(req), action: 'ROLE_PERMISSIONS_UPDATE', entityType: 'Role', entityId: req.params.id, detail: `${toArray(req.body.permissionKeys).length} perms` });
    res.redirect('/admin/roles?msg=' + encodeURIComponent('Permissions updated'));
  } catch (e) { res.redirect('/admin/roles?err=' + encodeURIComponent((e as Error).message)); }
}));

usersRouter.post('/admin/roles/:id/meta', manage, asyncHandler(async (req, res) => {
  await rolesSvc.updateRoleMeta(req.params.id, String(req.body.name ?? ''), String(req.body.description ?? ''));
  await audit({ ...actor(req), action: 'ROLE_UPDATE', entityType: 'Role', entityId: req.params.id });
  res.redirect('/admin/roles?msg=' + encodeURIComponent('Role updated'));
}));

usersRouter.post('/admin/roles/:id/delete', manage, asyncHandler(async (req, res) => {
  try {
    await rolesSvc.deleteRole(req.params.id);
    await audit({ ...actor(req), action: 'ROLE_DELETE', entityType: 'Role', entityId: req.params.id });
    res.redirect('/admin/roles?msg=' + encodeURIComponent('Role deleted'));
  } catch (e) { res.redirect('/admin/roles?err=' + encodeURIComponent((e as Error).message)); }
}));

// ---- Delete (soft) ----
usersRouter.post('/admin/users/:id/delete', manage, asyncHandler(async (req, res) => {
  if (req.params.id === req.principal!.userId) {
    return res.redirect('/admin/users?err=' + encodeURIComponent('You cannot delete your own account'));
  }
  await users.deleteUser(req.params.id);
  await audit({ ...actor(req), action: 'USER_DELETE', entityType: 'User', entityId: req.params.id });
  res.redirect('/admin/users?msg=' + encodeURIComponent('User removed'));
}));
