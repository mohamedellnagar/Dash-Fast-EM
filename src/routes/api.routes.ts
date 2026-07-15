import { Router } from 'express';
import { z } from 'zod';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission, schoolScopeFor } from '../middleware/auth';
import { executiveKpis, registrationsBySubject, completionBySchool, RegistrationFilter } from '../services/analytics.service';
import { parseFilter, buildRegistrationWhere, safeSort } from '../services/filters';
import { listRegistrationsWhere } from '../services/dashboard.service';
import { syncRegistration } from '../services/sync/sync.service';
import { normalizeTestCode } from '../lib/testcode';
import { prisma } from '../db/prisma';
import { audit } from '../services/audit.service';
import { listWorkspacesMasked } from '../services/workspace.service';

export const apiRouter = Router();

// Legacy simple-filter shim kept for the Phase 1 executive KPI endpoint.
function filterFromQuery(req: any): RegistrationFilter {
  const scope = schoolScopeFor(req.principal);
  return {
    schoolIds: scope,
    subjectId: req.query.subjectId || undefined,
    schoolId: req.query.schoolId || undefined,
    grade: req.query.grade || undefined,
    dashboardStatus: req.query.status || undefined,
    search: req.query.search || undefined,
  };
}

apiRouter.get('/kpis', requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  const filter = filterFromQuery(req);
  const [kpis, bySubject, bySchool] = await Promise.all([
    executiveKpis(filter),
    registrationsBySubject(filter),
    completionBySchool(filter),
  ]);
  res.json({ kpis, bySubject, bySchool });
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

// Advanced, server-side filtered registrations listing.
apiRouter.get('/registrations', requirePermission(PERMISSION.MONITORING_VIEW), async (req, res) => {
  const q = listQuery.parse(req.query);
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere(filter, scope);
  const { field, dir } = safeSort(q.sortBy, q.sortDir);
  const result = await listRegistrationsWhere(where, q.page, q.pageSize, field, dir);
  res.json(result);
});

apiRouter.post('/registrations/:id/sync', requirePermission(PERMISSION.MANUAL_SYNC), async (req, res) => {
  const result = await syncRegistration(req.params.id);
  await audit({
    userId: req.principal!.userId,
    actorEmail: req.principal!.email,
    action: 'MANUAL_SYNC',
    entityType: 'ExamRegistration',
    entityId: req.params.id,
    detail: result.ok ? `status=${result.dashboardStatus}` : `error=${result.errorType}`,
    ipAddress: req.ip,
  });
  res.json(result);
});

// Manual sync by TestCode (Live Monitoring quick action). Normalizes the code,
// resolves the registration (respecting school scope), and syncs it immediately.
const syncByCodeSchema = z.object({ testCode: z.string().min(1).max(60) });
apiRouter.post('/registrations/sync-by-code', requirePermission(PERMISSION.MANUAL_SYNC), async (req, res) => {
  const parsed = syncByCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'testCode is required' });
  const normalized = normalizeTestCode(parsed.data.testCode);
  if (!normalized) return res.status(400).json({ ok: false, error: 'Invalid TestCode' });

  const scope = schoolScopeFor(req.principal!);
  const reg = await prisma.examRegistration.findFirst({
    where: {
      testCodeNormalized: normalized,
      deletedAt: null,
      ...(scope ? { schoolId: { in: scope.length ? scope : ['__none__'] } } : {}),
    },
    select: { id: true, testCodeOriginal: true },
  });
  if (!reg) return res.status(404).json({ ok: false, error: `No registration found for TestCode ${parsed.data.testCode}` });

  const result = await syncRegistration(reg.id);
  await audit({
    userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'MANUAL_SYNC',
    entityType: 'ExamRegistration', entityId: reg.id,
    detail: `by-code ${normalized} → ${result.ok ? `status=${result.dashboardStatus}` : `error=${result.errorType}`}`,
    ipAddress: req.ip,
  });
  res.json({ ...result, testCode: reg.testCodeOriginal });
});

// Bulk soft-delete registrations — by explicit ids, or ALL matching the current
// filter. Respects school scope; sets deletedAt (reversible, hidden everywhere).
const deleteSchema = z.object({
  ids: z.array(z.string()).max(10000).optional(),
  allMatching: z.boolean().optional(),
});
apiRouter.post('/registrations/delete', requirePermission(PERMISSION.IMPORT_RUN), async (req, res) => {
  const p = deleteSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ ok: false, error: 'Invalid request' });
  const scope = schoolScopeFor(req.principal!);

  let where: any;
  if (p.data.allMatching) {
    // Filters are carried on the POST querystring (the page's current filters).
    const filter = parseFilter(req.query as Record<string, unknown>);
    where = buildRegistrationWhere(filter, scope);
  } else if (p.data.ids && p.data.ids.length) {
    where = { AND: [buildRegistrationWhere({}, scope), { id: { in: p.data.ids } }] };
  } else {
    return res.status(400).json({ ok: false, error: 'No rows selected' });
  }

  const result = await prisma.examRegistration.updateMany({
    where: { AND: [where, { deletedAt: null }] },
    data: { deletedAt: new Date() },
  });
  await audit({
    userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'REGISTRATION_DELETE',
    detail: p.data.allMatching ? `all-matching-filter deleted=${result.count}` : `selected=${p.data.ids?.length} deleted=${result.count}`,
    ipAddress: req.ip,
  });
  res.json({ ok: true, deleted: result.count });
});

apiRouter.get('/workspaces', requirePermission(PERMISSION.INTEGRATION_MANAGE), requireAuth, async (_req, res) => {
  res.json(await listWorkspacesMasked());
});
