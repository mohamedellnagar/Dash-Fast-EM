import { Router, Request } from 'express';
import { PERMISSION } from '../lib/enums';
import { requirePermission, schoolScopeFor } from '../middleware/auth';
import { asyncHandler } from '../middleware/async-handler';
import { parseFilter, buildRegistrationWhere } from '../services/filters';
import * as dash from '../services/dashboard.service';
import { subscribeDashboardLive } from '../services/observability/dashboard-live.service';

export const dashboardApiRouter = Router();

// Live global snapshot over SSE: one shared timer computes the whole Live
// Overview bundle every 2s and fans it out to all viewers, so N open screens
// cost one set of queries instead of N. Scoped users still use the per-request
// JSON endpoints; this stream is the unfiltered operations wall.
dashboardApiRouter.get('/live', requirePermission(PERMISSION.DASHBOARD_VIEW), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  subscribeDashboardLive(res, () => undefined);
});

// Build a scoped where-clause from the request (school scope is server-enforced).
function whereFrom(req: Request) {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  return { filter, scope, where: buildRegistrationWhere(filter, scope) };
}

/** Parse the page-wide multi-subject selector (CSV) for the raw-SQL endpoints. */
function subjectsParam(req: Request): string[] | undefined {
  const raw = String(req.query.examSubjects || '').trim();
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

const view = requirePermission(PERMISSION.DASHBOARD_VIEW);

dashboardApiRouter.get('/overview', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json(await dash.overview(where));
}));

dashboardApiRouter.get('/participation', view, asyncHandler(async (req, res) => {
  res.json(await dash.participationCoverage(String(req.query.programType || '') || undefined, subjectsParam(req)));
}));

dashboardApiRouter.get('/todays-activity', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json(await dash.todaysActivity(where));
}));

dashboardApiRouter.get('/sync-feed', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ items: await dash.recentSyncActivity(where, 40) });
}));

dashboardApiRouter.get('/status-distribution', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json(await dash.statusDistribution(where));
}));

dashboardApiRouter.get('/schools', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ schools: await dash.schoolsSummary(where) });
}));

dashboardApiRouter.get('/schools/:schoolId', view, asyncHandler(async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  if (scope && !scope.includes(req.params.schoolId)) return res.status(403).json({ error: 'Forbidden' });
  const filter = parseFilter(req.query as Record<string, unknown>);
  const where = buildRegistrationWhere({ ...filter, schoolId: req.params.schoolId }, scope);
  const [kpis, byGrade, bySubject, trends, cis] = await Promise.all([
    dash.kpiBlock(where),
    dash.completionByGrade(where),
    dash.subjectsSummary(where),
    dash.completionTrends(where),
    dash.correctIncorrectSkipped(where),
  ]);
  res.json({ schoolId: req.params.schoolId, kpis, byGrade, bySubject, trends, correctIncorrectSkipped: cis });
}));

dashboardApiRouter.get('/subjects', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ subjects: await dash.subjectsSummary(where) });
}));

dashboardApiRouter.get('/subjects/:subject', view, asyncHandler(async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  const filter = parseFilter(req.query as Record<string, unknown>);
  const examSubject = decodeURIComponent(req.params.subject);
  const where = buildRegistrationWhere({ ...filter, examSubject }, scope);
  const [kpis, bySchool, byGrade, scoresBySchool, durations, dist, trends, workspace] = await Promise.all([
    dash.kpiBlock(where),
    dash.schoolsSummary(where),
    dash.completionByGrade(where),
    dash.scoresBySchool(where),
    dash.durationsBySubject(where),
    dash.scoreDistribution(where),
    dash.completionTrends(where),
    dash.workspaceHealthForSubject(examSubject),
  ]);
  res.json({ subject: examSubject, kpis, bySchool, byGrade, scoresBySchool, durations, scoreDistribution: dist, trends, workspace });
}));

dashboardApiRouter.get('/completion-by-grade', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ grades: await dash.completionByGrade(where) });
}));

dashboardApiRouter.get('/completion-trends', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ trends: await dash.completionTrends(where) });
}));

dashboardApiRouter.get('/scores', view, requirePermission(PERMISSION.RESULTS_VIEW), asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  const [bySubject, bySchool, distribution, cis] = await Promise.all([
    dash.scoresBySubject(where), dash.scoresBySchool(where), dash.scoreDistribution(where, 10, 60), dash.correctIncorrectSkipped(where),
  ]);
  res.json({ bySubject, bySchool, distribution, correctIncorrectSkipped: cis });
}));

dashboardApiRouter.get('/exam-analytics', view, asyncHandler(async (req, res) => {
  res.json(await dash.examOperationalAnalytics(String(req.query.programType || '') || undefined, subjectsParam(req)));
}));

dashboardApiRouter.get('/durations', view, asyncHandler(async (req, res) => {
  const { where } = whereFrom(req);
  res.json({ bySubject: await dash.durationsBySubject(where) });
}));

dashboardApiRouter.get('/api-health', requirePermission(PERMISSION.API_MONITORING_VIEW), asyncHandler(async (_req, res) => {
  res.json(await dash.apiHealth());
}));
