import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { buildRegistrationWhere } from '../../src/services/filters';
import * as dash from '../../src/services/dashboard.service';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';

let wsId: string;
let schoolA: string;
let schoolB: string;

beforeAll(async () => {
  const ws = await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Analytics WS', subjectCode: 'ANALYTICS', baseUrl: 'https://x.test/api' } });
  wsId = ws.id;
});

beforeEach(async () => {
  await clearRegistrations();
  schoolA = (await makeSchool('School A')).id;
  schoolB = (await makeSchool('School B')).id;

  // School A: 2 completed (with results), 1 in progress, 1 not started
  await makeRegistration({ schoolId: schoolA, examSubject: 'Math', grade: '5', status: 'COMPLETED', workspaceId: wsId, startDate: '2026-09-01', result: { secondsUsed: 1800, rawScore: 18, scaledScore: 200, correct: 15, incorrect: 3, skipped: 2, completionPercentage: 90 } });
  await makeRegistration({ schoolId: schoolA, examSubject: 'Math', grade: '5', status: 'COMPLETED', workspaceId: wsId, startDate: '2026-09-01', result: { secondsUsed: 2200, rawScore: 12, scaledScore: 180, correct: 10, incorrect: 6, skipped: 4, completionPercentage: 80 } });
  await makeRegistration({ schoolId: schoolA, examSubject: 'Math', grade: '5', status: 'IN_PROGRESS' });
  await makeRegistration({ schoolId: schoolA, examSubject: 'Arabic', grade: '6', status: 'NOT_STARTED' });
  // School B: 1 completed, 1 review failed
  await makeRegistration({ schoolId: schoolB, examSubject: 'Arabic', grade: '6', status: 'COMPLETED', workspaceId: wsId, startDate: '2026-09-02', result: { secondsUsed: 1000, rawScore: 20, scaledScore: 240, correct: 20, incorrect: 0, skipped: 0, completionPercentage: 100 } });
  await makeRegistration({ schoolId: schoolB, examSubject: 'Arabic', grade: '6', status: 'REVIEW_FAILED' });
});

const whereAll = () => buildRegistrationWhere({});

describe('KPI accuracy', () => {
  it('status counts and completion rate match the data', async () => {
    const k = await dash.kpiBlock(whereAll());
    expect(k.totalRegistered).toBe(6);
    expect(k.COMPLETED).toBe(3);
    expect(k.IN_PROGRESS).toBe(1);
    expect(k.NOT_STARTED).toBe(1);
    expect(k.REVIEW_FAILED).toBe(1);
    // completion rate = completed / total = 3/6 = 50%
    expect(k.completionRate).toBe(50);
  });

  it('aggregates correct/incorrect/skipped and averages from results only', async () => {
    const k = await dash.kpiBlock(whereAll());
    // correct: 15+10+20=45, incorrect: 3+6+0=9, skipped: 2+4+0=6
    expect(k.correct).toBe(45);
    expect(k.incorrect).toBe(9);
    expect(k.skipped).toBe(6);
    // avg raw score over 3 results = (18+12+20)/3 = 16.67
    expect(k.avgRawScore).toBeCloseTo(16.67, 1);
  });

  it('returns null (not 0) for averages when no results match', async () => {
    const where = buildRegistrationWhere({ status: 'NOT_STARTED' });
    const k = await dash.kpiBlock(where);
    expect(k.avgRawScore).toBeNull();
    expect(k.avgTimeUsedSeconds).toBeNull();
  });
});

describe('School & subject summaries', () => {
  it('per-school totals and completion rate', async () => {
    const rows = await dash.schoolsSummary(whereAll());
    const a = rows.find((r) => r.schoolId === schoolA)!;
    expect(a.total).toBe(4);
    expect(a.COMPLETED).toBe(2);
    expect(a.completionRate).toBe(50);
    expect(a.avgRawScore).toBeCloseTo(15, 0); // (18+12)/2
  });

  it('per-subject breakdown with item sums', async () => {
    const rows = await dash.subjectsSummary(whereAll());
    const math = rows.find((r) => r.examSubject === 'Math')!;
    expect(math.total).toBe(3);
    expect(math.COMPLETED).toBe(2);
    expect(math.correct).toBe(25); // 15+10
  });

  it('completion by grade', async () => {
    const g = await dash.completionByGrade(whereAll());
    const g5 = g.find((x) => x.grade === '5')!;
    expect(g5.total).toBe(3);
    expect(g5.completed).toBe(2);
  });
});

describe('Distributions & trends', () => {
  it('score distribution buckets denormalized raw scores', async () => {
    const buckets = await dash.scoreDistribution(whereAll());
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(3); // three results have rawScore
  });

  it('completion trends group by exam start date', async () => {
    const t = await dash.completionTrends(whereAll());
    const d1 = t.find((x) => x.date === '2026-09-01')!;
    expect(d1.total).toBe(2);
    expect(d1.completed).toBe(2);
  });
});

describe('KPIs match the filtered table (single source of truth)', () => {
  it('filtering by school narrows both KPIs and counts consistently', async () => {
    const where = buildRegistrationWhere({ schoolId: schoolB });
    const [k, count] = await Promise.all([
      dash.kpiBlock(where),
      prisma.examRegistration.count({ where }),
    ]);
    expect(k.totalRegistered).toBe(count);
    expect(k.totalRegistered).toBe(2);
  });
});
