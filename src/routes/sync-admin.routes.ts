import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSION, JOB_TYPE } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit.service';
import {
  queueStats, cancelJob, retryJob, retryFailedJobs, requeueDeadLetter,
  pauseWorkspace, pauseJobType, pauseGlobal, setSyncWindow, getSyncControlState, setGlobalMaxRpm,
  pauseSubject, getSubjectSyncControls, setFastMode, setSyncMode,
  pauseAcademicYear, getAcademicYearSyncControls,
} from '../services/sync/queue.service';
import { setFastTestFrozen, setConnectionTestDisabled } from '../services/fasttest/freeze';
import { listWorkers } from '../services/sync/worker-registry.service';
import { listAlerts, acknowledgeAlert, resolveAlert, assignAlert, addAlertNote, alertSummary } from '../services/observability/alert.service';
import { invalidateRateConfig } from '../services/sync/rate-limiter.service';

export const syncAdminRouter = Router();

function actor(req: any) {
  return { userId: req.principal.userId, actorEmail: req.principal.email, ipAddress: req.ip };
}

// ---- Queue Monitoring Dashboard ----
syncAdminRouter.get('/admin/queue', requireAuth, requirePermission(PERMISSION.QUEUE_VIEW), async (req, res) => {
  const [stats, workers, snapshots, deadLetter, recentFailed, workspaces, controlState, subjectControls, yearControls] = await Promise.all([
    queueStats(),
    listWorkers(),
    prisma.queueMetricSnapshot.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    prisma.syncJob.findMany({ where: { status: 'DEAD_LETTER' }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.syncJob.findMany({ where: { status: { in: ['FAILED', 'MANUAL_REVIEW'] } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.fastTestWorkspace.findMany({ where: { deletedAt: null }, include: { circuitBreaker: true } }),
    getSyncControlState(),
    getSubjectSyncControls(),
    getAcademicYearSyncControls(),
  ]);
  const healthy = workers.filter((w) => w.status === 'HEALTHY').length;
  res.render('queue', {
    title: 'Queue Monitoring', principal: req.principal, nav: 'queue',
    stats, workers, healthy, snapshots: snapshots.reverse(), deadLetter, recentFailed, workspaces,
    jobTypes: Object.values(JOB_TYPE), controlState, subjectControls, yearControls,
  });
});

syncAdminRouter.get('/api/queue/stats', requireAuth, requirePermission(PERMISSION.QUEUE_VIEW), async (_req, res) => {
  res.json(await queueStats());
});

// ---- Queue actions (permission + audit) ----
syncAdminRouter.post('/api/queue/jobs/:id/retry', requireAuth, requirePermission(PERMISSION.SYNC_RETRY), async (req, res) => {
  const ok = await retryJob(req.params.id);
  await audit({ ...actor(req), action: 'QUEUE_RETRY', entityType: 'SyncJob', entityId: req.params.id });
  res.json({ ok });
});
syncAdminRouter.post('/api/queue/jobs/:id/cancel', requireAuth, requirePermission(PERMISSION.SYNC_CANCEL), async (req, res) => {
  const ok = await cancelJob(req.params.id);
  await audit({ ...actor(req), action: 'QUEUE_CANCEL', entityType: 'SyncJob', entityId: req.params.id });
  res.json({ ok });
});
syncAdminRouter.post('/api/queue/retry-failed', requireAuth, requirePermission(PERMISSION.SYNC_RETRY), async (req, res) => {
  const n = await retryFailedJobs({ workspaceId: req.body?.workspaceId, jobType: req.body?.jobType });
  await audit({ ...actor(req), action: 'QUEUE_RETRY_FAILED', detail: `count=${n}` });
  res.json({ ok: true, requeued: n });
});
syncAdminRouter.post('/api/queue/jobs/:id/requeue', requireAuth, requirePermission(PERMISSION.SYNC_ADMIN), async (req, res) => {
  const ok = await requeueDeadLetter(req.params.id);
  await audit({ ...actor(req), action: 'QUEUE_DEADLETTER_REQUEUE', entityType: 'SyncJob', entityId: req.params.id });
  res.json({ ok });
});

const pauseSchema = z.object({ paused: z.boolean() });
syncAdminRouter.post('/api/queue/workspaces/:id/pause', requireAuth, requirePermission(PERMISSION.WORKSPACE_PAUSE), async (req, res) => {
  const p = pauseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid input' });
  await pauseWorkspace(req.params.id, p.data.paused, req.principal!.email);
  invalidateRateConfig(req.params.id);
  await audit({ ...actor(req), action: p.data.paused ? 'WORKSPACE_PAUSE' : 'WORKSPACE_RESUME', entityType: 'FastTestWorkspace', entityId: req.params.id });
  res.json({ ok: true });
});
// Per-workspace rate-limit override. Sets (or updates) the throughput ceiling
// for a single workspace; invalidating the cache makes it take effect within
// seconds. maxRpm is the main knob (requests/min); maxRps and maxConcurrent
// guard bursts. Kept within sane bounds so a typo can't hammer FastTest.
const rateSchema = z.object({
  maxRpm: z.number().int().min(1).max(6000),
  maxRps: z.number().min(0.1).max(100),
  maxConcurrent: z.number().int().min(1).max(64),
});
syncAdminRouter.post('/api/queue/workspaces/:id/rate-limit', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = rateSchema.safeParse({
    maxRpm: Number(req.body?.maxRpm), maxRps: Number(req.body?.maxRps), maxConcurrent: Number(req.body?.maxConcurrent),
  });
  if (!p.success) return res.status(400).json({ error: 'Invalid rate values' });
  const ws = await prisma.fastTestWorkspace.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  // A manual rate-limit edit turns auto-tune off — the operator is taking over.
  // Derive minDelayMs from rpm so a stale 200ms spacing can't silently cap
  // throughput below the chosen rpm.
  const minDelayMs = Math.max(5, Math.floor(60000 / p.data.maxRpm));
  await prisma.workspaceRateLimit.upsert({
    where: { workspaceId: req.params.id },
    create: { workspaceId: req.params.id, maxRpm: p.data.maxRpm, maxRps: p.data.maxRps, maxConcurrent: p.data.maxConcurrent, minDelayMs, autoTune: false },
    update: { maxRpm: p.data.maxRpm, maxRps: p.data.maxRps, maxConcurrent: p.data.maxConcurrent, minDelayMs, autoTune: false },
  });
  invalidateRateConfig(req.params.id);
  await audit({ ...actor(req), action: 'WORKSPACE_RATE_LIMIT', entityType: 'FastTestWorkspace', entityId: req.params.id, detail: `rpm=${p.data.maxRpm} rps=${p.data.maxRps} conc=${p.data.maxConcurrent}` });
  res.json({ ok: true });
});

// Toggle auto-tune (AIMD) for a workspace. When enabled, the system raises
// maxRpm while healthy and cuts it on FastTest pushback; the stored maxRpm
// becomes the live tuned value. Seeds a sane starting point on first enable.
syncAdminRouter.post('/api/queue/workspaces/:id/autotune', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  const ws = await prisma.fastTestWorkspace.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  const existing = await prisma.workspaceRateLimit.findUnique({ where: { workspaceId: req.params.id } });
  const seedRpm = existing?.maxRpm && existing.maxRpm >= 60 ? existing.maxRpm : 120;
  await prisma.workspaceRateLimit.upsert({
    where: { workspaceId: req.params.id },
    create: { workspaceId: req.params.id, autoTune: enabled, maxRpm: seedRpm, maxRps: Math.ceil(seedRpm / 30), maxConcurrent: Math.max(3, Math.ceil(seedRpm / 60)) },
    update: { autoTune: enabled },
  });
  invalidateRateConfig(req.params.id);
  await audit({ ...actor(req), action: enabled ? 'WORKSPACE_AUTOTUNE_ON' : 'WORKSPACE_AUTOTUNE_OFF', entityType: 'FastTestWorkspace', entityId: req.params.id });
  res.json({ ok: true, autoTune: enabled });
});
syncAdminRouter.post('/api/queue/job-types/:jobType/pause', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = pauseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid input' });
  await pauseJobType(req.params.jobType, p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'JOBTYPE_PAUSE' : 'JOBTYPE_RESUME', detail: req.params.jobType });
  res.json({ ok: true });
});

// ---- Master FastTest kill-switch (stops ALL FastTest operations) ----
syncAdminRouter.post('/api/queue/fasttest-freeze', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = pauseSchema.safeParse({ paused: req.body?.frozen });
  if (!p.success) return res.status(400).json({ error: 'frozen (boolean) required' });
  await setFastTestFrozen(p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'FASTTEST_FREEZE_ON' : 'FASTTEST_FREEZE_OFF' });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// ---- Connection Test switch (independent of sync; blocks manual connection tests) ----
syncAdminRouter.post('/api/queue/connection-test-toggle', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = pauseSchema.safeParse({ paused: req.body?.disabled });
  if (!p.success) return res.status(400).json({ error: 'disabled (boolean) required' });
  await setConnectionTestDisabled(p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'CONNECTION_TEST_DISABLED' : 'CONNECTION_TEST_ENABLED' });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// ---- Global on/off switch ----
syncAdminRouter.post('/api/queue/global/pause', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = pauseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid input' });
  await pauseGlobal(p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'SYNC_GLOBAL_PAUSE' : 'SYNC_GLOBAL_RESUME' });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// ---- Daily time window (hours 0-23; null/null clears) ----
const windowSchema = z.object({
  startHour: z.number().int().min(0).max(23).nullable(),
  endHour: z.number().int().min(0).max(23).nullable(),
});
syncAdminRouter.post('/api/queue/window', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = windowSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'startHour/endHour must be 0-23 or null' });
  await setSyncWindow(p.data.startHour, p.data.endHour, req.principal!.email);
  await audit({ ...actor(req), action: 'SYNC_WINDOW_SET', detail: `start=${p.data.startHour} end=${p.data.endHour}` });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// Global sync/min ceiling across all workspaces (0 / null = unlimited).
const globalRpmSchema = z.object({ rpm: z.number().int().min(0).max(100000).nullable() });
syncAdminRouter.post('/api/queue/global-rate', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = globalRpmSchema.safeParse({ rpm: req.body?.rpm === '' || req.body?.rpm == null ? null : Number(req.body?.rpm) });
  if (!p.success) return res.status(400).json({ error: 'rpm must be 0-100000 or null' });
  await setGlobalMaxRpm(p.data.rpm, req.principal!.email);
  await audit({ ...actor(req), action: 'SYNC_GLOBAL_RATE_SET', detail: `rpm=${p.data.rpm ?? 'unlimited'}` });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// ---- Current control state ----
syncAdminRouter.get('/api/queue/control-state', requireAuth, requirePermission(PERMISSION.QUEUE_VIEW), async (_req, res) => {
  res.json(await getSyncControlState());
});

// ---- Fast (turbo) sync mode ----
syncAdminRouter.post('/api/queue/fast-mode', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = pauseSchema.safeParse({ paused: req.body?.enabled });
  if (!p.success) return res.status(400).json({ error: 'enabled (boolean) required' });
  await setFastMode(p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'SYNC_FAST_MODE_ON' : 'SYNC_FAST_MODE_OFF' });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// Switch the sync strategy: ADAPTIVE (per-status intervals) vs SWEEP (round-robin).
syncAdminRouter.post('/api/queue/sync-mode', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const mode = req.body?.mode === 'SWEEP' ? 'SWEEP' : req.body?.mode === 'ADAPTIVE' ? 'ADAPTIVE' : null;
  if (!mode) return res.status(400).json({ error: "mode must be 'ADAPTIVE' or 'SWEEP'" });
  await setSyncMode(mode, req.principal!.email);
  await audit({ ...actor(req), action: mode === 'SWEEP' ? 'SYNC_MODE_SWEEP' : 'SYNC_MODE_ADAPTIVE' });
  res.json({ ok: true, ...(await getSyncControlState()) });
});

// ---- Per-subject sync on/off (subject names can contain spaces → use body) ----
const subjectPauseSchema = z.object({ subject: z.string().min(1).max(200), paused: z.boolean() });
syncAdminRouter.post('/api/queue/subjects/pause', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = subjectPauseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'subject and paused required' });
  await pauseSubject(p.data.subject, p.data.paused, req.principal!.email);
  await audit({ ...actor(req), action: p.data.paused ? 'SUBJECT_SYNC_PAUSE' : 'SUBJECT_SYNC_RESUME', detail: p.data.subject });
  res.json({ ok: true, subjects: await getSubjectSyncControls() });
});

// ---- Per-academic-year sync on/off ----
const yearPauseSchema = z.object({ academicYear: z.string().min(1).max(20), paused: z.boolean() });
syncAdminRouter.post('/api/queue/academic-years/pause', requireAuth, requirePermission(PERMISSION.QUEUE_MANAGE), async (req, res) => {
  const p = yearPauseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'academicYear and paused required' });
  const effect = await pauseAcademicYear(p.data.academicYear, p.data.paused, req.principal!.email);
  await audit({
    ...actor(req),
    action: p.data.paused ? 'YEAR_SYNC_PAUSE' : 'YEAR_SYNC_RESUME',
    detail: p.data.paused
      ? `${p.data.academicYear} — cancelled ${effect.cancelled} queued job(s), ${effect.stillRunning} still finishing`
      : p.data.academicYear,
  });
  res.json({ ok: true, ...effect, years: await getAcademicYearSyncControls() });
});

// ---- Worker health ----
// Worker Health page removed.
syncAdminRouter.get('/admin/workers', requireAuth, (_req, res) => res.redirect('/admin/queue'));

// ---- Sync history ----
syncAdminRouter.get('/admin/sync-history', requireAuth, requirePermission(PERMISSION.SYNC_VIEW), async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const where: any = {};
  if (req.query.status) where.status = req.query.status;
  const [total, attempts] = await Promise.all([
    prisma.syncJobAttempt.count(),
    prisma.syncJobAttempt.findMany({
      orderBy: { startedAt: 'desc' }, skip: (page - 1) * 50, take: 50,
      include: { job: { select: { jobType: true, registrationId: true, workspaceId: true, testCodeNormalized: true } } },
    }),
  ]);
  const transitions = await prisma.syncStateTransition.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  res.render('sync-history', { title: 'Sync History', principal: req.principal, nav: 'sync-history', attempts, transitions, page, total, totalPages: Math.max(1, Math.ceil(total / 50)) });
});

// ---- Alerts ----
syncAdminRouter.get('/admin/alerts', requireAuth, requirePermission(PERMISSION.ALERT_VIEW), async (req, res) => {
  const [alerts, summary] = await Promise.all([listAlerts(req.query.status as string), alertSummary()]);
  res.render('alerts', { title: 'Alerts & Monitoring', principal: req.principal, nav: 'alerts', alerts, summary, query: req.query });
});
syncAdminRouter.get('/api/alerts', requireAuth, requirePermission(PERMISSION.ALERT_VIEW), async (req, res) => {
  res.json({ alerts: await listAlerts(req.query.status as string), summary: await alertSummary() });
});
syncAdminRouter.post('/api/alerts/:id/ack', requireAuth, requirePermission(PERMISSION.ALERT_MANAGE), async (req, res) => {
  await acknowledgeAlert(req.params.id);
  await audit({ ...actor(req), action: 'ALERT_ACK', entityType: 'SystemAlert', entityId: req.params.id });
  res.json({ ok: true });
});
syncAdminRouter.post('/api/alerts/:id/resolve', requireAuth, requirePermission(PERMISSION.ALERT_MANAGE), async (req, res) => {
  await resolveAlert(req.params.id, req.principal!.email);
  await audit({ ...actor(req), action: 'ALERT_RESOLVE', entityType: 'SystemAlert', entityId: req.params.id });
  res.json({ ok: true });
});
syncAdminRouter.post('/api/alerts/:id/notes', requireAuth, requirePermission(PERMISSION.ALERT_MANAGE), async (req, res) => {
  const schema = z.object({ note: z.string().trim().min(1).max(2000) });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Note required' });
  const note = await addAlertNote(req.params.id, p.data.note, req.principal!.userId, req.principal!.email);
  res.status(201).json(note);
});
