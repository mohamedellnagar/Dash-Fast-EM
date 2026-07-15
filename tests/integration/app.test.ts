import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import { ROLE } from '../../src/lib/enums';

const app = createApp();
const ADMIN_EMAIL = 'admin@fasttest.local';
const ADMIN_PW = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe!Admin123';
const VIEWER_EMAIL = 'viewer@fasttest.local';
const VIEWER_PW = 'ViewerPass!123';

beforeAll(async () => {
  const role = await prisma.role.findUnique({ where: { key: ROLE.VIEWER } });
  const existing = await prisma.user.findUnique({ where: { email: VIEWER_EMAIL } });
  if (!existing && role) {
    const u = await prisma.user.create({ data: { email: VIEWER_EMAIL, passwordHash: await hashPassword(VIEWER_PW), fullName: 'Viewer User' } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
  }
});

async function loginAgent(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ email, password });
  return { agent, res };
}

describe('Health endpoints', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  it('GET /health/database reports reachable', async () => {
    const res = await request(app).get('/health/database');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('reachable');
  });
  it('GET /health/fasttest lists workspaces', async () => {
    const res = await request(app).get('/health/fasttest');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.workspaces)).toBe(true);
  });
});

describe('Authentication', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
  it('rejects invalid credentials with 401', async () => {
    const res = await request(app).post('/login').type('form').send({ email: ADMIN_EMAIL, password: 'wrong' });
    expect(res.status).toBe(401);
  });
  it('logs the failed attempt to the audit log', async () => {
    await request(app).post('/login').type('form').send({ email: ADMIN_EMAIL, password: 'wrong-again' });
    const count = await prisma.auditLog.count({ where: { action: 'LOGIN_FAILED' } });
    expect(count).toBeGreaterThan(0);
  });
  it('accepts valid admin credentials and reaches the dashboard', async () => {
    const { agent, res } = await loginAgent(ADMIN_EMAIL, ADMIN_PW);
    expect(res.status).toBe(302);
    const dash = await agent.get('/monitoring');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Live Monitoring');
  });
});

describe('RBAC enforcement', () => {
  it('admin can open Integration Settings', async () => {
    const { agent } = await loginAgent(ADMIN_EMAIL, ADMIN_PW);
    const res = await agent.get('/admin/integration');
    expect(res.status).toBe(200);
  });
  it('viewer is forbidden from Integration Settings', async () => {
    const { agent } = await loginAgent(VIEWER_EMAIL, VIEWER_PW);
    const res = await agent.get('/admin/integration');
    expect(res.status).toBe(403);
  });
  it('viewer cannot run exports (API 403)', async () => {
    const { agent } = await loginAgent(VIEWER_EMAIL, VIEWER_PW);
    const res = await agent.get('/export/registrations?format=csv');
    expect(res.status).toBe(403);
  });
  it('unauthenticated API returns 401 JSON', async () => {
    const res = await request(app).get('/api/kpis');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });
});
