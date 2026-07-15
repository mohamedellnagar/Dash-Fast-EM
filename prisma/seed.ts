import { PrismaClient } from '@prisma/client';
import { env } from '../src/config/env';
import { hashPassword } from '../src/services/auth.service';
import { encryptOrNull } from '../src/lib/crypto';
import { ROLE, PERMISSION } from '../src/lib/enums';
import { ROLE_PERMISSIONS } from '../src/services/rbac.service';
import { normalizeAlias } from '../src/services/workspace.service';

const prisma = new PrismaClient();

const ROLE_NAMES: Record<string, string> = {
  [ROLE.ADMINISTRATOR]: 'Administrator',
  [ROLE.OPERATIONS]: 'Operations',
  [ROLE.ASSESSMENT_TEAM]: 'Assessment Team',
  [ROLE.SCHOOL_USER]: 'School User',
  [ROLE.VIEWER]: 'Viewer',
};

// Canonical subjects + default aliases → workspace subject codes.
const SUBJECTS = [
  { code: 'ARABIC', name: 'Arabic', envKey: 'ARABIC', aliases: ['Arabic', 'Arabic Reading', 'Arabic Writing', 'Arabic Language'] },
  { code: 'ENGLISH', name: 'English', envKey: 'ENGLISH', aliases: ['English', 'English Language'] },
  { code: 'MATH', name: 'Mathematics', envKey: 'MATH', aliases: ['Math', 'Maths', 'Mathematics'] },
  { code: 'SCIENCE', name: 'Science', envKey: 'SCIENCE', aliases: ['Science'] },
];

async function seedPermissions() {
  for (const key of Object.values(PERMISSION)) {
    await prisma.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
}

async function seedRoles() {
  for (const [key, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: { key, name: ROLE_NAMES[key] ?? key },
      update: { name: ROLE_NAMES[key] ?? key },
    });
    // Reset grants to match the source-of-truth map.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const p of perms) {
      const perm = await prisma.permission.findUnique({ where: { key: p } });
      if (perm) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
  }
}

async function seedAdmin() {
  const email = env.bootstrapAdminEmail.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  const passwordHash = await hashPassword(env.bootstrapAdminPassword);
  const user = existing
    ? await prisma.user.update({ where: { email }, data: { isActive: true } })
    : await prisma.user.create({ data: { email, passwordHash, fullName: 'System Administrator', isActive: true } });

  const adminRole = await prisma.role.findUnique({ where: { key: ROLE.ADMINISTRATOR } });
  if (adminRole) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      create: { userId: user.id, roleId: adminRole.id },
      update: {},
    });
  }
  console.log(`  admin user: ${email}`);
}

async function seedSubjectsAndWorkspaces() {
  for (const s of SUBJECTS) {
    await prisma.subject.upsert({ where: { code: s.code }, create: { code: s.code, name: s.name }, update: { name: s.name } });

    const apiKey = env.fasttest.keys[s.envKey] || '';
    // Only create a workspace when there isn't one for this subject already.
    let ws = await prisma.fastTestWorkspace.findFirst({ where: { subjectCode: s.code, deletedAt: null } });
    if (!ws) {
      ws = await prisma.fastTestWorkspace.create({
        data: {
          workspaceName: `${s.name} Workspace`,
          subjectCode: s.code,
          baseUrl: env.fasttest.baseUrl,
          restApiKeyEncrypted: encryptOrNull(apiKey || null),
          usernameEncrypted: encryptOrNull(env.fasttest.username || null),
          passwordEncrypted: encryptOrNull(env.fasttest.password || null),
          tokenTTL: env.fasttest.tokenTtlSeconds,
          isActive: true,
          syncEnabled: !!apiKey, // don't enable sync for a keyless workspace
        },
      });
      console.log(`  workspace: ${ws.workspaceName}${apiKey ? '' : ' (no API key — configure in Integration Settings)'}`);
    }

    const subject = await prisma.subject.findUnique({ where: { code: s.code } });
    for (const alias of s.aliases) {
      await prisma.workspaceSubjectMapping.upsert({
        where: { aliasNormalized: normalizeAlias(alias) },
        create: { workspaceId: ws.id, subjectId: subject?.id ?? null, subjectAlias: alias, aliasNormalized: normalizeAlias(alias) },
        update: { workspaceId: ws.id },
      });
    }
  }
}

async function main() {
  console.log('Seeding database…');
  await seedPermissions();
  await seedRoles();
  await seedAdmin();
  await seedSubjectsAndWorkspaces();
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
