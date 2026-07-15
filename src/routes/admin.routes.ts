import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { encryptOrNull } from '../lib/crypto';
import { getWorkspaceById, listWorkspacesMasked, normalizeAlias } from '../services/workspace.service';
import { FastTestClient } from '../services/fasttest/client';
import { assertConnectionTestEnabled } from '../services/fasttest/freeze';
import { audit } from '../services/audit.service';
import { getFastTestHealth, getFastTestStatusLight } from '../services/observability/fasttest-health.service';

export const adminRouter = Router();

// FastTest Health & Efficiency — live page + JSON feed.
adminRouter.get('/admin/fasttest-health', requireAuth, requirePermission(PERMISSION.API_MONITORING_VIEW), async (req, res) => {
  res.render('fasttest-health', { title: 'FastTest Health', principal: req.principal, nav: 'fasttest-health' });
});
adminRouter.get('/api/fasttest/health', requireAuth, requirePermission(PERMISSION.API_MONITORING_VIEW), async (_req, res) => {
  res.json(await getFastTestHealth());
});

/**
 * Server-Sent Events helper: opens a text/event-stream, pushes an initial frame,
 * then re-pushes `produce()` every `everyMs` until the client disconnects. Errors
 * in one tick are swallowed so a transient DB blip doesn't drop the stream.
 */
function sse(res: any, req: any, everyMs: number, produce: () => Promise<unknown>) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  const push = async () => {
    if (closed) return;
    try {
      const data = await produce();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      res.write('event: error\ndata: {}\n\n');
    }
  };
  void push();
  const timer = setInterval(push, everyMs);
  req.on('close', () => { closed = true; clearInterval(timer); });
}

// Real-time full health feed for the FastTest Health page (pushes every 3s).
adminRouter.get('/api/fasttest/health/stream', requireAuth, requirePermission(PERMISSION.API_MONITORING_VIEW), (req, res) => {
  sse(res, req, 3000, () => getFastTestHealth());
});

// Real-time light status for the global top-bar badge — available to any signed-in
// user (it's just an up/down colour, no sensitive detail). Pushes every 4s.
adminRouter.get('/api/fasttest/status/stream', requireAuth, (req, res) => {
  sse(res, req, 4000, () => getFastTestStatusLight());
});

// Integration Settings (admin only)
adminRouter.get('/admin/integration', requireAuth, requirePermission(PERMISSION.INTEGRATION_MANAGE), async (req, res) => {
  const workspaces = await listWorkspacesMasked();
  const mappings = await prisma.workspaceSubjectMapping.findMany({ include: { workspace: true }, orderBy: { subjectAlias: 'asc' } });
  res.render('integration', { title: 'Integration Settings', principal: req.principal, workspaces, mappings, nav: 'integration', flash: req.query.msg ?? null });
});

const workspaceSchema = z.object({
  workspaceName: z.string().min(1).max(120),
  subjectCode: z.string().min(1).max(60),
  baseUrl: z.string().url().max(300),
  tokenTTL: z.coerce.number().int().min(60).max(86400).default(3600),
  restApiKey: z.string().max(500).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
  syncEnabled: z.coerce.boolean().optional(),
});

adminRouter.post('/admin/integration/workspaces', requireAuth, requirePermission(PERMISSION.INTEGRATION_MANAGE), async (req, res) => {
  const parsed = workspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/integration?msg=Invalid+input');
  const d = parsed.data;
  const ws = await prisma.fastTestWorkspace.create({
    data: {
      workspaceName: d.workspaceName,
      subjectCode: normalizeAlias(d.subjectCode),
      baseUrl: d.baseUrl,
      tokenTTL: d.tokenTTL,
      restApiKeyEncrypted: encryptOrNull(d.restApiKey),
      usernameEncrypted: encryptOrNull(d.username),
      passwordEncrypted: encryptOrNull(d.password),
      isActive: d.isActive ?? true,
      syncEnabled: d.syncEnabled ?? true,
    },
  });
  await audit({ userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'CONFIG_CHANGE', entityType: 'FastTestWorkspace', entityId: ws.id, detail: `created workspace ${d.workspaceName}`, ipAddress: req.ip });
  res.redirect('/admin/integration?msg=Workspace+created');
});

// Connection test (authenticates; never returns the token to the client)
adminRouter.post('/admin/integration/workspaces/:id/test', requireAuth, requirePermission(PERMISSION.INTEGRATION_MANAGE), async (req, res) => {
  const ws = await getWorkspaceById(req.params.id);
  if (!ws) return res.status(404).json({ ok: false, error: 'Workspace not found' });
  try {
    await assertConnectionTestEnabled();
  } catch (e: any) {
    return res.status(403).json({ ok: false, error: e.code ?? 'CONNECTION_TEST_DISABLED', message: e.message });
  }
  const client = new FastTestClient();
  try {
    const auth = await client.authenticate(ws);
    await audit({ userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'CONFIG_CHANGE', entityType: 'FastTestWorkspace', entityId: ws.workspaceId, detail: 'connection test SUCCESS', ipAddress: req.ip });
    res.json({ ok: true, workspaceName: auth.workspaceName ?? ws.workspaceName, ttl: auth.ttl ?? ws.tokenTTL });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e.errorType ?? 'AUTH_FAILED', message: e.message });
  }
});

// Subject alias mapping
const mappingSchema = z.object({ workspaceId: z.string().min(1), subjectAlias: z.string().min(1).max(120) });
adminRouter.post('/admin/integration/mappings', requireAuth, requirePermission(PERMISSION.INTEGRATION_MANAGE), async (req, res) => {
  const parsed = mappingSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/admin/integration?msg=Invalid+mapping');
  const alias = parsed.data.subjectAlias;
  await prisma.workspaceSubjectMapping.upsert({
    where: { aliasNormalized: normalizeAlias(alias) },
    create: { workspaceId: parsed.data.workspaceId, subjectAlias: alias, aliasNormalized: normalizeAlias(alias) },
    update: { workspaceId: parsed.data.workspaceId, subjectAlias: alias },
  });
  res.redirect('/admin/integration?msg=Mapping+saved');
});

// API monitoring page
adminRouter.get('/admin/api-monitoring', requireAuth, requirePermission(PERMISSION.API_MONITORING_VIEW), async (req, res) => {
  const logs = await prisma.apiRequestLog.findMany({ orderBy: { requestedAt: 'desc' }, take: 200, include: { workspace: true } });
  const agg = await prisma.apiRequestLog.aggregate({ _avg: { responseTimeMs: true }, _count: { _all: true } });
  const failures = await prisma.apiRequestLog.count({ where: { success: false } });
  res.render('api-monitoring', {
    title: 'API Monitoring', principal: req.principal, logs, nav: 'api-monitoring',
    stats: { total: agg._count._all, avgMs: Math.round(agg._avg.responseTimeMs ?? 0), failures },
  });
});

// Audit log viewer
adminRouter.get('/admin/audit', requireAuth, requirePermission(PERMISSION.AUDIT_VIEW), async (req, res) => {
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  res.render('audit', { title: 'Audit Log', principal: req.principal, logs, nav: 'audit' });
});
