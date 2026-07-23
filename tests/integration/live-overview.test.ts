import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import { ROLE } from '../../src/lib/enums';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';
import { computeSnapshot } from '../../src/services/observability/dashboard-live.service';
import { clearDashboardCache, participationCoverage } from '../../src/services/dashboard.service';
import { parseFilter, buildRegistrationWhere } from '../../src/services/filters';

const app = createApp();

// Dashboard aggregates are memoized for 15s; tests assert on rows they just
// wrote, so drop the cache between them.
beforeEach(() => clearDashboardCache());
const SCOPED_PW = 'ScopedPass!123';
const ADMIN_PW = 'AdminPass!123';
let scopedEmail: string;
let adminEmail: string;

async function makeUser(email: string, pw: string, roleKey: string, schoolIds: string[] = []) {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(pw), fullName: email } });
  if (role) await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
  for (const s of schoolIds) await prisma.userSchoolScope.create({ data: { userId: u.id, schoolId: s } });
  return u;
}

async function agentFor(email: string, pw: string) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password: pw });
  return agent;
}

beforeAll(async () => {
  await clearRegistrations();
  const school = (await makeSchool('Wall School')).id;
  // 3 live registrations + 2 soft-deleted ones the wall must ignore.
  for (const id of ['LIVE-1', 'LIVE-2', 'LIVE-3']) {
    await makeRegistration({ schoolId: school, studentExternalId: id, status: 'COMPLETED' });
  }
  for (const id of ['GONE-1', 'GONE-2']) {
    const reg = await makeRegistration({ schoolId: school, studentExternalId: id, status: 'COMPLETED' });
    await prisma.examRegistration.update({ where: { id: reg.id }, data: { deletedAt: new Date() } });
  }

  scopedEmail = `wall-scoped-${Date.now()}@t.local`;
  adminEmail = `wall-admin-${Date.now()}@t.local`;
  await makeUser(scopedEmail, SCOPED_PW, ROLE.SCHOOL_USER, [school]);
  await makeUser(adminEmail, ADMIN_PW, ROLE.ADMINISTRATOR);
});

describe('Live Overview wall — snapshot integrity', () => {
  it('excludes soft-deleted registrations from the global snapshot', async () => {
    const snap = await computeSnapshot();
    expect(snap.overview.totalRegistered).toBe(3);
    expect(snap.overview.COMPLETED).toBe(3);
  });

  it('status counts sum back to the reported total', async () => {
    const ov = (await computeSnapshot()).overview as Record<string, number>;
    const sum = ['NOT_SYNCED', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNDER_REVIEW', 'REVIEW_FAILED', 'UNKNOWN']
      .reduce((n, k) => n + (ov[k] ?? 0), 0);
    expect(sum).toBe(ov.totalRegistered);
  });

  it('agrees with a direct non-deleted count', async () => {
    const live = await prisma.examRegistration.count({ where: { deletedAt: null } });
    expect((await computeSnapshot()).overview.totalRegistered).toBe(live);
  });
});

describe('Live Overview wall — scope enforcement', () => {
  it('school-scoped user is blocked from the wall and its stream', async () => {
    const agent = await agentFor(scopedEmail, SCOPED_PW);
    expect((await agent.get('/wall')).status).toBe(403);
    expect((await agent.get('/overview')).status).toBe(403);
    expect((await agent.get('/api/dashboard/live')).status).toBe(403);
  });

  it('unrestricted admin still reaches the wall', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    expect((await agent.get('/wall')).status).toBe(200);
    expect((await agent.get('/overview')).status).toBe(200);
  });
});

describe('Live Overview wall — honest metrics', () => {
  it('reports null (not 100% / 0ms) when there was no API traffic', async () => {
    await prisma.apiRequestLog.deleteMany({});
    const ov = (await computeSnapshot()).overview;
    expect(ov.apiCallsLastHour).toBe(0);
    expect(ov.apiSuccessRate).toBeNull();
    expect(ov.avgResponseTimeMs).toBeNull();
  });

  it('reports a real rate once calls exist', async () => {
    const ws = await prisma.fastTestWorkspace.findFirst();
    if (!ws) return; // no workspace seeded — nothing to attribute calls to
    await prisma.apiRequestLog.createMany({
      data: [true, true, true, false].map((success) => ({
        workspaceId: ws.id, endpoint: '/t', method: 'GET', success, responseTimeMs: 100, requestedAt: new Date(),
      })),
    });
    const ov = (await computeSnapshot()).overview;
    expect(ov.apiCallsLastHour).toBe(4);
    expect(ov.apiSuccessRate).toBe(75);
    expect(ov.avgResponseTimeMs).toBe(100);
    await prisma.apiRequestLog.deleteMany({});
  });

  it('exposes the unique student count the wall renders', async () => {
    expect((await computeSnapshot()).overview.studentCount).toBeTypeOf('number');
  });
});

describe('Live Overview wall — exams vs instruments', () => {
  it('keeps a parent survey out of the exam completion rate', async () => {
    // Other tests in this file seed exam rows, so assert on the delta this test
    // introduces rather than assuming an empty database.
    const before = (await computeSnapshot()).byKind;
    const school = (await makeSchool('Kind School')).id;
    // 10 maths papers, 8 completed → exam rate 80%.
    for (let i = 0; i < 10; i++) {
      await makeRegistration({ schoolId: school, examSubject: 'Math', status: i < 8 ? 'COMPLETED' : 'NOT_STARTED' });
    }
    // 10 parent questionnaires, 2 returned → 20%, which must not drag the exams.
    for (let i = 0; i < 10; i++) {
      await makeRegistration({ schoolId: school, examSubject: 'parent questions En', status: i < 2 ? 'COMPLETED' : 'NOT_STARTED' });
    }
    clearDashboardCache();

    const after = (await computeSnapshot()).byKind;
    expect(after.exams.total - before.exams.total).toBe(10);
    expect(after.exams.completed - before.exams.completed).toBe(8);
    expect(after.instruments.total - before.instruments.total).toBe(10);
    expect(after.instruments.completed - before.instruments.completed).toBe(2);

    // The survey's 20% return rate must not appear in the exam rate. Blending
    // the two would land between them; the exam figure must stay above.
    expect(after.instruments.completionRate).toBe(20);
    expect(after.exams.completionRate).toBeGreaterThan(50);

    // And the per-subject rows keep their own, unblended rates.
    const rows = (await computeSnapshot()).subjects.subjects;
    const survey = rows.find((r: { examSubject: string }) => r.examSubject === 'parent questions En');
    expect(survey?.completionRate).toBe(20);
  });

  it('counts participation by sitting an exam, not by returning a form', async () => {
    const school = (await makeSchool('Forms Only School')).id;
    const eid = `EID-FORM-ONLY-${Date.now()}`;
    const before = await participationCoverage();
    clearDashboardCache();

    // One student: parent questionnaire returned, but the exam never started.
    // Counting all registrations reported them as participating; they did not sit.
    await makeRegistration({ schoolId: school, emiratesId: eid, examSubject: 'parent questions En', status: 'COMPLETED' });
    await makeRegistration({ schoolId: school, emiratesId: eid, examSubject: 'Math', status: 'NOT_STARTED' });
    clearDashboardCache();

    const after = await participationCoverage();
    expect(after.scope).toBe('EXAM');
    expect(after.students.targeted - before.students.targeted).toBe(1);      // targeted for Math
    expect(after.students.participating - before.students.participating).toBe(0); // but never sat it

    // Once they actually start the exam, they count.
    await makeRegistration({ schoolId: school, emiratesId: eid, examSubject: 'Arabic Reading', status: 'IN_PROGRESS' });
    clearDashboardCache();
    const sat = await participationCoverage();
    expect(sat.students.participating - before.students.participating).toBe(1);
  });

  it('splits every registration into exactly one bucket', async () => {
    const snap = await computeSnapshot();
    expect(snap.byKind.exams.total + snap.byKind.instruments.total)
      .toBe(snap.overview.totalRegistered);
  });

  it('tags each subject row with its kind', async () => {
    const rows = (await computeSnapshot()).subjects.subjects;
    const math = rows.find((r: { examSubject: string }) => r.examSubject === 'Math');
    const survey = rows.find((r: { examSubject: string }) => r.examSubject === 'parent questions En');
    expect(math?.kind).toBe('EXAM');
    expect(survey?.kind).toBe('INSTRUMENT');
  });
});

describe('Live Overview wall — status coverage', () => {
  it('renders every dashboard status, including the review states', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const html = (await agent.get('/wall')).text;
    for (const key of ['NOT_SYNCED', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED',
      'UNDER_REVIEW', 'REVIEW_FAILED', 'UNKNOWN']) {
      expect(html).toContain(`key:'${key}'`);
    }
  });
});

describe('Live Overview wall — output escaping', () => {
  it('escapes school and subject names rendered via innerHTML', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const html = (await agent.get('/wall')).text;
    expect(html).toContain('var esc = function(s)');

    // Assert the invariant, not the call sites: no server-supplied field may be
    // concatenated into markup unescaped. This keeps holding as the render code
    // is refactored, which a literal `esc(s.examSubject)` check does not.
    // Concatenating an untrusted field with a plain label ('Grade ' + g.grade)
    // is fine as long as the result is escaped; what must never appear is a
    // field glued directly to a string literal that carries markup.
    const UNTRUSTED = ['schoolName', 'examSubject', 'grade', 'code', 'subject', 'label'];
    for (const field of UNTRUSTED) {
      const intoMarkup = new RegExp(
        `(?:'[^']*[<>"][^']*'\\s*\\+\\s*(?:it|s|g)\\.${field}\\b` +
        `|\\+\\s*(?:it|s|g)\\.${field}\\s*\\+\\s*'[^']*[<>"])`, 'g');
      expect(html.match(intoMarkup), `${field} reaches markup without esc()`).toBeNull();
    }
    // And the shared row builder escapes what it is handed.
    expect(html).toMatch(/function barRow\(label, cr\)\{[\s\S]*?esc\(label\)/);
  });
});

describe('Live Monitoring — start-hour filter', () => {
  it('builds an inclusive range for a normal window', () => {
    const where = buildRegistrationWhere(parseFilter({ startHourFrom: '8', startHourTo: '10' }), undefined);
    expect(JSON.stringify(where)).toContain('"actualStartLocalHour":{"gte":8,"lte":10}');
  });

  it('treats an open end as running to 23', () => {
    const where = buildRegistrationWhere(parseFilter({ startHourFrom: '14' }), undefined);
    expect(JSON.stringify(where)).toContain('"gte":14');
    expect(JSON.stringify(where)).toContain('"lte":23');
  });

  it('wraps around midnight when the end precedes the start', () => {
    const where = buildRegistrationWhere(parseFilter({ startHourFrom: '21', startHourTo: '2' }), undefined);
    const json = JSON.stringify(where);
    expect(json).toContain('"OR"');
    expect(json).toContain('"gte":21');
    expect(json).toContain('"lte":2');
  });

  it('adds nothing when neither bound is given', () => {
    const where = buildRegistrationWhere(parseFilter({}), undefined);
    expect(JSON.stringify(where)).not.toContain('actualStartLocalHour');
  });

  it('rejects an hour outside 0-23 instead of filtering on nonsense', () => {
    expect(JSON.stringify(buildRegistrationWhere(parseFilter({ startHourFrom: '99' }), undefined)))
      .not.toContain('actualStartLocalHour');
  });

  it('actually selects the right rows', async () => {
    const school = (await makeSchool('Hour Filter School')).id;
    const morning = await makeRegistration({ schoolId: school, examSubject: 'Math', status: 'COMPLETED' });
    const evening = await makeRegistration({ schoolId: school, examSubject: 'Math', status: 'COMPLETED' });
    await prisma.examRegistration.update({ where: { id: morning.id }, data: { actualStartLocalHour: 8 } });
    await prisma.examRegistration.update({ where: { id: evening.id }, data: { actualStartLocalHour: 19 } });

    const where = buildRegistrationWhere(parseFilter({ startHourFrom: '7', startHourTo: '9' }), undefined);
    const ids = (await prisma.examRegistration.findMany({ where, select: { id: true } })).map((r) => r.id);
    expect(ids).toContain(morning.id);
    expect(ids).not.toContain(evening.id);
  });
});
