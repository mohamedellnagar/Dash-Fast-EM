/**
 * Convert stored FastTest exam timestamps from the vendor's US clock to a real
 * UTC instant, for rows synced before the conversion existed.
 *
 * Idempotent and non-destructive: it writes only the derived columns
 * (startTimeUtc / startTimeResolution / startTimeSourceTz) and never touches
 * the vendor's original string, so it can be re-run at any time — including
 * after changing FASTTEST_SOURCE_TZ, or once FastTest starts returning an
 * unambiguous clock.
 *
 *   npx ts-node --transpile-only scripts/backfill-exam-times.ts [--dry-run] [--batch=1000]
 */
import { prisma } from '../src/db/prisma';
import { env } from '../src/config/env';
import { resolveExamTime, offsetHoursBetween, zoneObservesDst } from '../src/lib/exam-time';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH = Number(args.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 1000);

async function main(): Promise<void> {
  const displayTz = env.displayTimezone;
  // FastTest's timezone setting is per workspace, verified against their portal:
  // some record in UTC and some in US Central. Applying one zone to all of them
  // mis-stated half the estate by five hours.
  const workspaces = await prisma.fastTestWorkspace.findMany({
    select: { id: true, workspaceName: true, sourceTimeZone: true },
  });
  const zoneOf = new Map(workspaces.map((w) => [w.id, w.sourceTimeZone ?? env.fasttest.sourceTimezone]));
  const fallbackTz = env.fasttest.sourceTimezone;
  console.log(`display (ours)    : ${displayTz}`);
  console.log('source per workspace:');
  for (const w of workspaces.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName))) {
    const tz = w.sourceTimeZone ?? fallbackTz;
    const summer = offsetHoursBetween(tz, displayTz, new Date(Date.UTC(2025, 6, 15)));
    const winter = offsetHoursBetween(tz, displayTz, new Date(Date.UTC(2025, 11, 15)));
    const shift = zoneObservesDst(tz) ? `+${summer}h summer / +${winter}h winter` : `+${summer}h year-round`;
    console.log(`  ${w.workspaceName.padEnd(12)} ${tz.padEnd(20)} ${shift}`
      + (w.sourceTimeZone ? '' : '  (env default)'));
  }
  console.log(DRY_RUN ? 'mode              : DRY RUN — nothing written\n' : 'mode              : WRITE\n');

  const total = await prisma.fastTestResult.count({ where: { startTime: { not: null } } });
  console.log(`${total.toLocaleString()} rows carry a vendor timestamp\n`);

  const tally: Record<string, number> = {};
  const hours: Record<number, number> = {};
  let processed = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.fastTestResult.findMany({
      where: { startTime: { not: null } },
      select: {
        id: true, startTime: true, registrationId: true,
        registration: { select: { startTime: true, endTime: true, workspaceId: true } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const tz = zoneOf.get(row.registration?.workspaceId ?? '') ?? fallbackTz;
      const t = resolveExamTime({
        raw: row.startTime,
        sourceTimeZone: tz,
        displayTimeZone: displayTz,
        windowStart: row.registration?.startTime,
        windowEnd: row.registration?.endTime,
      });
      tally[t.resolution] = (tally[t.resolution] ?? 0) + 1;
      if (t.displayHour !== null) hours[t.displayHour] = (hours[t.displayHour] ?? 0) + 1;

      if (!DRY_RUN) {
        await prisma.fastTestResult.update({
          where: { id: row.id },
          data: { startTimeUtc: t.utc, startTimeResolution: t.resolution, startTimeSourceTz: tz },
        });
        await prisma.examRegistration.update({
          where: { id: row.registrationId },
          data: {
            actualStartTimeUtc: t.utc,
            actualStartTimeResolution: t.resolution,
            actualStartLocalHour: t.displayHour,
          },
        }).catch(() => undefined); // registration may have been soft-deleted
      }
    }

    processed += rows.length;
    process.stdout.write(`\r  processed ${processed.toLocaleString()} / ${total.toLocaleString()}`);
  }

  console.log('\n\noutcome:');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(7)}  ${((v / processed) * 100).toFixed(1)}%`);
  }

  const keys = Object.keys(hours).map(Number).sort((a, b) => a - b);
  if (keys.length) {
    const max = Math.max(...Object.values(hours));
    console.log(`\nexam start hour in ${displayTz} after conversion:`);
    for (const h of keys) {
      console.log(`  ${String(h).padStart(2, '0')}:00 ${String(hours[h]).padStart(6)} ${'#'.repeat(Math.round((hours[h] / max) * 40))}`);
    }
  }
  if (DRY_RUN) console.log('\n(dry run — re-run without --dry-run to persist)');
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
