import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import { ROLE } from '../../src/lib/enums';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';

const app = createApp();
const SCHOOL_USER_PW = 'SchoolPass!123';
const VIEWER_PW = 'ViewerPass!123';
let scopedSchool: string;
let otherSchool: string;
let schoolUserEmail: string;
let viewerEmail: string;

async function makeUser(email: string, pw: string, roleKey: string, schoolIds: string[] = []) {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(pw), fullName: email } });
  if (role) await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
  for (const s of schoolIds) await prisma.userSchoolScope.create({ data: { userId: u.id, schoolId: s } });
  return u;
}

beforeAll(async () => {
  await clearRegistrations();
  scopedSchool = (await makeSchool('Scoped School')).id;
  otherSchool = (await makeSchool('Other School')).id;
  // 2 regs in scoped school, 3 in other
  await makeRegistration({ schoolId: scopedSchool, studentExternalId: 'SCOPED-1' });
  await makeRegistration({ schoolId: scopedSchool, studentExternalId: 'SCOPED-2' });
  await makeRegistration({ schoolId: otherSchool, studentExternalId: 'OTHER-1' });
  await makeRegistration({ schoolId: otherSchool, studentExternalId: 'OTHER-2' });
  await makeRegistration({ schoolId: otherSchool, studentExternalId: 'OTHER-3' });

  schoolUserEmail = `school-${Date.now()}@t.local`;
  viewerEmail = `viewer2-${Date.now()}@t.local`;
  await makeUser(schoolUserEmail, SCHOOL_USER_PW, ROLE.SCHOOL_USER, [scopedSchool]);
  await makeUser(viewerEmail, VIEWER_PW, ROLE.VIEWER);
});

async function agentFor(email: string, pw: string) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password: pw });
  return agent;
}

describe('School-scoped access control (server-enforced)', () => {
  it('school user only sees their assigned school in /api/registrations', async () => {
    const agent = await agentFor(schoolUserEmail, SCHOOL_USER_PW);
    const res = await agent.get('/api/registrations?pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const ids = res.body.rows.map((r: any) => r.studentExternalId).sort();
    expect(ids).toEqual(['SCOPED-1', 'SCOPED-2']);
  });

  it('school user cannot bypass scope by passing another schoolId', async () => {
    const agent = await agentFor(schoolUserEmail, SCHOOL_USER_PW);
    const res = await agent.get(`/api/registrations?schoolId=${otherSchool}&pageSize=100`);
    expect(res.body.total).toBe(0); // scope AND schoolId → empty
  });

  it('school user gets 403 opening another school detail page', async () => {
    const agent = await agentFor(schoolUserEmail, SCHOOL_USER_PW);
    const res = await agent.get(`/schools/${otherSchool}`);
    expect(res.status).toBe(403);
  });

  it('viewer cannot access the attention queue', async () => {
    const agent = await agentFor(viewerEmail, VIEWER_PW);
    // The standalone attention page was removed; the route now redirects to /monitoring.
    expect((await agent.get('/attention')).status).toBe(302);
    expect((await agent.get('/api/attention')).status).toBe(403);
  });

  it('viewer cannot export', async () => {
    const agent = await agentFor(viewerEmail, VIEWER_PW);
    expect((await agent.get('/export/registrations?preset=ALL&format=csv')).status).toBe(403);
  });

  it('unauthenticated analytics API returns 401', async () => {
    expect((await request(app).get('/api/dashboard/overview')).status).toBe(401);
  });
});
