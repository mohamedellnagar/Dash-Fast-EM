import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import { ROLE, PERMISSION } from '../../src/lib/enums';
import { ROLE_PERMISSIONS } from '../../src/services/rbac.service';

const app = createApp();
const OPS_PW = 'OpsPass!123';
const VIEW_PW = 'ViewPass!123';
let opsEmail: string;
let viewerEmail: string;

async function makeUser(email: string, pw: string, roleKey: string) {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(pw), fullName: email } });
  if (role) await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
}
async function agentFor(email: string, pw: string) {
  const a = request.agent(app);
  await a.post('/login').type('form').send({ email, password: pw });
  return a;
}

beforeAll(async () => {
  opsEmail = `ops-${Date.now()}@t.local`;
  viewerEmail = `v3-${Date.now()}@t.local`;
  await makeUser(opsEmail, OPS_PW, ROLE.OPERATIONS);
  await makeUser(viewerEmail, VIEW_PW, ROLE.VIEWER);
});

describe('Phase 3 RBAC grants', () => {
  it('operations has queue/sync/alert operational permissions but not sync:admin', () => {
    const ops = ROLE_PERMISSIONS[ROLE.OPERATIONS];
    expect(ops).toContain(PERMISSION.QUEUE_VIEW);
    expect(ops).toContain(PERMISSION.SYNC_BULK);
    expect(ops).toContain(PERMISSION.WORKSPACE_PAUSE);
    expect(ops).not.toContain(PERMISSION.SYNC_ADMIN);
  });
  it('viewer has none of the sync-platform permissions', () => {
    const v = ROLE_PERMISSIONS[ROLE.VIEWER];
    for (const p of [PERMISSION.SYNC_VIEW, PERMISSION.QUEUE_VIEW, PERMISSION.ALERT_VIEW, PERMISSION.WORKSPACE_PAUSE]) {
      expect(v).not.toContain(p);
    }
  });
  it('only administrator has sync:admin', () => {
    expect(ROLE_PERMISSIONS[ROLE.ADMINISTRATOR]).toContain(PERMISSION.SYNC_ADMIN);
    for (const r of [ROLE.OPERATIONS, ROLE.ASSESSMENT_TEAM, ROLE.SCHOOL_USER, ROLE.VIEWER]) {
      expect(ROLE_PERMISSIONS[r]).not.toContain(PERMISSION.SYNC_ADMIN);
    }
  });
});

describe('Phase 3 endpoint authorization', () => {
  it('operations can open queue, sync control, workers, alerts', async () => {
    const a = await agentFor(opsEmail, OPS_PW);
    expect((await a.get('/admin/queue')).status).toBe(200);
    expect((await a.get('/sync')).status).toBe(200);
    // /admin/workers page was removed; it now redirects to the queue monitor.
    expect((await a.get('/admin/workers')).status).toBe(302);
    expect((await a.get('/admin/alerts')).status).toBe(200);
  });
  it('viewer is forbidden from the sync platform pages', async () => {
    const a = await agentFor(viewerEmail, VIEW_PW);
    expect((await a.get('/admin/queue')).status).toBe(403);
    expect((await a.get('/sync')).status).toBe(403);
    expect((await a.get('/admin/alerts')).status).toBe(403);
  });
  it('bulk sync enforces a maximum selection', async () => {
    const a = await agentFor(opsEmail, OPS_PW);
    const tooMany = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await a.post('/api/sync/bulk').send({ action: 'SYNC', registrationIds: tooMany });
    expect(res.status).toBe(400);
  });
  it('queue action writes an audit log entry', async () => {
    const a = await agentFor(opsEmail, OPS_PW);
    const job = await prisma.syncJob.create({ data: { jobType: 'SYNC_REGISTRATION_STATUS', status: 'FAILED' } });
    await a.post(`/api/queue/jobs/${job.id}/retry`);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'QUEUE_RETRY', entityId: job.id } });
    expect(audit).not.toBeNull();
  });
  it('metrics endpoint is reachable and emits queue gauges', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('sync_queue_depth');
  });
});
