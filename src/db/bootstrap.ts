import { prisma } from './prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { hashPassword } from '../services/auth.service';
import { ROLE, PERMISSION } from '../lib/enums';
import { ROLE_PERMISSIONS } from '../services/rbac.service';

const ROLE_NAMES: Record<string, string> = {
  [ROLE.ADMINISTRATOR]: 'Administrator',
  [ROLE.OPERATIONS]: 'Operations',
  [ROLE.ASSESSMENT_TEAM]: 'Assessment Team',
  [ROLE.SCHOOL_USER]: 'School User',
  [ROLE.VIEWER]: 'Viewer',
};

/**
 * Give every role that already holds `anchor` the permissions in `add`, without
 * removing anything. Used to roll a new permission out to existing, admin-edited
 * roles that the first-run seed no longer touches.
 */
async function grantIfMissing(anchor: string, add: string[]): Promise<void> {
  const anchorPerm = await prisma.permission.findUnique({ where: { key: anchor } });
  if (!anchorPerm) return;
  const holders = await prisma.rolePermission.findMany({
    where: { permissionId: anchorPerm.id },
    select: { roleId: true },
  });
  for (const key of add) {
    const perm = await prisma.permission.findUnique({ where: { key } });
    if (!perm) continue;
    for (const { roleId } of holders) {
      const has = await prisma.rolePermission.findFirst({ where: { roleId, permissionId: perm.id } });
      if (!has) await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
    }
  }
}

/**
 * Idempotent first-boot bootstrap: ensures the permission catalog, the RBAC
 * roles + their grants, and the bootstrap administrator all exist. Safe to run
 * on every startup — it upserts and never destroys user data. This lets a fresh
 * deployment (e.g. EasyPanel) come up ready to log in without a manual seed step.
 * Subjects/workspaces are intentionally NOT seeded — those are configured in-app.
 */
export async function ensureBootstrap(): Promise<void> {
  try {
    // 1. Permissions
    for (const key of Object.values(PERMISSION)) {
      await prisma.permission.upsert({ where: { key }, create: { key }, update: {} });
    }

    // 2. Roles + grants. ROLE_PERMISSIONS is the FIRST-RUN seed only — once a role
    //    has grants they are admin-managed (edited in the UI) and preserved across
    //    restarts. EXCEPTION: the Administrator role is always re-asserted to full
    //    access so nobody can accidentally lock the platform out of itself.
    for (const [key, perms] of Object.entries(ROLE_PERMISSIONS)) {
      const role = await prisma.role.upsert({
        where: { key },
        create: { key, name: ROLE_NAMES[key] ?? key },
        update: { name: ROLE_NAMES[key] ?? key },
      });
      const existingGrants = await prisma.rolePermission.count({ where: { roleId: role.id } });
      const isAdmin = key === ROLE.ADMINISTRATOR;
      if (isAdmin || existingGrants === 0) {
        await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
        for (const p of perms) {
          const perm = await prisma.permission.findUnique({ where: { key: p } });
          if (perm) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
        }
      }
    }

    // 2b. Additive backfill for Manual Verification.
    //
    // Roles that already have grants are admin-managed and left alone by the
    // block above, so a brand-new permission would never reach them and the
    // upgraded page would 403 for existing Operations users. Manual Verification
    // replaced a page previously gated on sync:manual, so every role already
    // holding sync:manual keeps equivalent access — view + execute only. The
    // sensitive/raw/export grants stay opt-in through the Roles UI.
    await grantIfMissing(PERMISSION.MANUAL_SYNC, [
      PERMISSION.MANUAL_VERIFICATION_VIEW,
      PERMISSION.MANUAL_VERIFICATION_EXECUTE,
    ]);

    // 3. Bootstrap admin
    const email = env.bootstrapAdminEmail.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    const user = existing
      ? await prisma.user.update({ where: { email }, data: { isActive: true } })
      : await prisma.user.create({
          data: { email, passwordHash: await hashPassword(env.bootstrapAdminPassword), fullName: 'System Administrator', isActive: true },
        });
    const adminRole = await prisma.role.findUnique({ where: { key: ROLE.ADMINISTRATOR } });
    if (adminRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
        create: { userId: user.id, roleId: adminRole.id },
        update: {},
      });
    }
    logger.info({ admin: email, seeded: !existing }, 'bootstrap ensured (permissions, roles, admin)');
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'bootstrap failed (continuing; DB may be mid-migration)');
  }
}
