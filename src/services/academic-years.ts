import { prisma } from '../db/prisma';

// Distinct academic years present in the data, cached briefly (used to build the
// global Academic Year selector in the nav on every page).
let cache: { at: number; years: string[] } | null = null;
const TTL_MS = 60_000;

export async function getAcademicYears(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.years;
  const rows = await prisma.examRegistration.findMany({
    where: { academicYear: { not: null }, deletedAt: null },
    distinct: ['academicYear'],
    select: { academicYear: true },
    orderBy: { academicYear: 'desc' },
  });
  const years = rows.map((r) => r.academicYear!).filter((y) => y && y.trim() !== '');
  cache = { at: Date.now(), years };
  return years;
}
