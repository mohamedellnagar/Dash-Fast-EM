import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSION, JOB_TYPE, SYNC_STATE } from '../lib/enums';
import { requireAuth, requirePermission, schoolScopeFor } from '../middleware/auth';
import { parseFilter, buildRegistrationWhere, safeSort } from '../services/filters';
import { listRegistrationsWhere } from '../services/dashboard.service';
import { enqueue, cancelJob } from '../services/sync/queue.service';
import { transitionState } from '../services/sync/state';
import { audit } from '../services/audit.service';

export const syncControlRouter = Router();

const MAX_SELECTION = 500; // hard cap — no unrestricted bulk sync

// ---- Sync Control Center page ----
syncControlRouter.get('/sync', requireAuth, requirePermission(PERMISSION.SYNC_VIEW), async (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere(filter, scope);
  const page = Number(req.query.page ?? 1);
  const { field, dir } = safeSort(req.query.sortBy as string, req.query.sortDir as string);
  const data = await listRegistrationsWhere(where, page, 50, field, dir);

  // Latest active queue job per listed registration.
  const regIds = data.rows.map((r: any) => r.id);
  const jobs = await prisma.syncJob.findMany({
    where: { registrationId: { in: regIds }, status: { in: ['QUEUED', 'RUNNING', 'RETRY_SCHEDULED'] } },
    orderBy: { updatedAt: 'desc' },
  });
  const jobByReg = new Map<string, any>();
  for (const j of jobs) if (!jobByReg.has(j.registrationId!)) jobByReg.set(j.registrationId!, j);

  const [subjects, schools, workspaces] = await Promise.all([
    prisma.subject.findMany({ orderBy: { name: 'asc' } }),
    prisma.school.findMany({ where: scope ? { id: { in: scope }, deletedAt: null } : { deletedAt: null }, orderBy: { name: 'asc' } }),
    prisma.fastTestWorkspace.findMany({ where: { deletedAt: null }, orderBy: { subjectCode: 'asc' } }),
  ]);

  res.render('sync-control', {
    title: 'Sync Control Center', principal: req.principal, nav: 'sync-control',
    data, query: req.query, jobByReg, subjects, schools, workspaces,
    canBulk: req.principal!.permissions.has(PERMISSION.SYNC_BULK),
    maxSelection: MAX_SELECTION,
  });
});

function actor(req: any) {
  return { userId: req.principal.userId, actorEmail: req.principal.email, ipAddress: req.ip };
}

// ---- Bulk action on selected registrations ----
const bulkSchema = z.object({
  action: z.enum(['SYNC', 'CANCEL', 'MANUAL_REVIEW']),
  registrationIds: z.array(z.string()).min(1).max(MAX_SELECTION),
});

syncControlRouter.post('/api/sync/bulk', requireAuth, requirePermission(PERMISSION.SYNC_BULK), async (req, res) => {
  const p = bulkSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid input or selection exceeds limit', max: MAX_SELECTION });
  const { action, registrationIds } = p.data;

  // Enforce school scope: filter ids to those the user may act on.
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere({}, scope);
  const allowed = await prisma.examRegistration.findMany({ where: { AND: [where, { id: { in: registrationIds } }] }, select: { id: true, workspaceId: true, examSubject: true, schoolId: true, testCodeNormalized: true } });

  let affected = 0;
  for (const reg of allowed) {
    if (action === 'SYNC') {
      const r = await enqueue({ jobType: JOB_TYPE.MANUAL_SYNC, workspaceId: reg.workspaceId, registrationId: reg.id, subject: reg.examSubject, schoolId: reg.schoolId, testCodeNormalized: reg.testCodeNormalized, priority: 10, createdBy: req.principal!.email });
      if (!r.deduped) affected++;
    } else if (action === 'CANCEL') {
      const active = await prisma.syncJob.findMany({ where: { registrationId: reg.id, status: { in: ['QUEUED', 'RETRY_SCHEDULED'] } } });
      for (const j of active) if (await cancelJob(j.id)) affected++;
    } else if (action === 'MANUAL_REVIEW') {
      await transitionState(reg.id, SYNC_STATE.MANUAL_REVIEW, { reason: `operator (${req.principal!.email})` });
      await prisma.examRegistration.update({ where: { id: reg.id }, data: { syncStatus: 'MANUAL_REVIEW', nextSyncAt: null } });
      affected++;
    }
  }
  await audit({ ...actor(req), action: `SYNC_BULK_${action}`, detail: `selected=${registrationIds.length} affected=${affected}` });
  res.json({ ok: true, action, requested: registrationIds.length, affected });
});

// ---- Batch by workspace / school / subject ----
syncControlRouter.post('/api/sync/workspace/:id', requireAuth, requirePermission(PERMISSION.SYNC_BULK), async (req, res) => {
  const r = await enqueue({ jobType: JOB_TYPE.SYNC_WORKSPACE_BATCH, workspaceId: req.params.id, priority: 70, createdBy: req.principal!.email });
  await audit({ ...actor(req), action: 'SYNC_WORKSPACE_BATCH', entityType: 'FastTestWorkspace', entityId: req.params.id });
  res.json({ ok: true, jobId: r.job.id, deduped: r.deduped });
});
syncControlRouter.post('/api/sync/school/:id', requireAuth, requirePermission(PERMISSION.SYNC_BULK), async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  if (scope && !scope.includes(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
  const r = await enqueue({ jobType: JOB_TYPE.SYNC_SCHOOL_BATCH, schoolId: req.params.id, priority: 70, createdBy: req.principal!.email });
  await audit({ ...actor(req), action: 'SYNC_SCHOOL_BATCH', entityType: 'School', entityId: req.params.id });
  res.json({ ok: true, jobId: r.job.id, deduped: r.deduped });
});
syncControlRouter.post('/api/sync/subject', requireAuth, requirePermission(PERMISSION.SYNC_BULK), async (req, res) => {
  const subject = String(req.body?.subject ?? '');
  if (!subject) return res.status(400).json({ error: 'subject required' });
  const r = await enqueue({ jobType: JOB_TYPE.SYNC_SUBJECT_BATCH, subject, priority: 70, createdBy: req.principal!.email, dedupeKey: `SYNC_SUBJECT_BATCH:${subject}` });
  await audit({ ...actor(req), action: 'SYNC_SUBJECT_BATCH', detail: subject });
  res.json({ ok: true, jobId: r.job.id, deduped: r.deduped });
});
