/* One-off backfill: link registrations that were imported before their SPA
 * workspaces existed (workspaceId = NULL) to the correct workspace by ExamName,
 * using the SAME resolution the app uses. Read-then-update; safe to re-run. */
import { prisma } from '../src/db/prisma';
import { resolveWorkspaceBySubject } from '../src/services/workspace.service';

(async () => {
  // Distinct ExamName among unlinked registrations.
  const groups = await prisma.examRegistration.groupBy({
    by: ['examName'],
    where: { deletedAt: null, workspaceId: null },
    _count: { _all: true },
  });

  console.log('Unlinked registrations by ExamName:');
  let totalLinked = 0;
  for (const g of groups) {
    const examName = g.examName;
    if (!examName) {
      console.log(`  (null ExamName): ${g._count._all} rows — cannot resolve, skipped`);
      continue;
    }
    const ws = await resolveWorkspaceBySubject(examName);
    if (!ws) {
      console.log(`  "${examName}": ${g._count._all} rows — NO workspace resolves, skipped`);
      continue;
    }
    const upd = await prisma.examRegistration.updateMany({
      where: { deletedAt: null, workspaceId: null, examName },
      data: { workspaceId: ws.workspaceId },
    });
    totalLinked += upd.count;
    console.log(`  "${examName}" → ${ws.workspaceName} [${ws.subjectCode}]: linked ${upd.count} rows`);
  }
  console.log(`\nTotal linked: ${totalLinked}`);

  const remaining = await prisma.examRegistration.count({ where: { deletedAt: null, workspaceId: null } });
  console.log(`Still unlinked (no matching workspace): ${remaining}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
