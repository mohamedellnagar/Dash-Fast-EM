import { Router, Request } from 'express';
import { prisma } from '../db/prisma';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission, schoolScopeFor } from '../middleware/auth';
import { executiveKpis, registrationsBySubject, completionBySchool, RegistrationFilter } from '../services/analytics.service';
import { parseFilter, buildRegistrationWhere, safeSort, filterToQuery } from '../services/filters';
import * as dash from '../services/dashboard.service';
import { REGISTRATION_COLUMNS, resolveColumns, DEFAULT_COLUMNS } from '../services/columns';
import { listViews, getDefaultView, hydrateView, getTablePreference } from '../services/saved-views.service';

export const dashboardRouter = Router();

function legacyFilter(req: any): RegistrationFilter {
  return {
    schoolIds: schoolScopeFor(req.principal),
    subjectId: req.query.subjectId || undefined,
    schoolId: req.query.schoolId || undefined,
    grade: req.query.grade || undefined,
    dashboardStatus: req.query.status || undefined,
    search: req.query.search || undefined,
  };
}

// Executive dashboard (Phase 1 — unchanged behaviour)
// Live Overview — in-app page that embeds the wall; full-screen at /wall.
dashboardRouter.get('/overview', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  res.render('overview-embed', { title: 'Live Overview', principal: req.principal, nav: 'wall' });
});

// Full-screen live overview wall (self-refreshing via the JSON APIs).
dashboardRouter.get('/wall', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  res.render('wall', { title: 'Live Overview', principal: req.principal, nav: 'wall' });
});

// ABA Analytics wall removed — redirect to Exam Operations.
dashboardRouter.get('/wall/aba', requireAuth, (_req, res) => res.redirect('/ops'));

// Operations — in-app page that embeds the ops wall; full-screen at /wall/ops.
dashboardRouter.get('/ops', requireAuth, requirePermission(PERMISSION.QUEUE_VIEW), async (req, res) => {
  res.render('ops-embed', { title: 'Operations Center', principal: req.principal, nav: 'ops-wall' });
});

// Full-screen live OPERATIONS wall — sync engine, queue, workers, API health.
dashboardRouter.get('/wall/ops', requireAuth, requirePermission(PERMISSION.QUEUE_VIEW), async (req, res) => {
  res.render('ops-wall', { title: 'Operations', principal: req.principal, nav: 'ops-wall' });
});

// Exam Operations ABA removed — its routes now land on the Operations Center.
dashboardRouter.get(['/exam', '/wall/exam', '/wall/schools'], requireAuth, (_req, res) => res.redirect('/ops'));

// Executive Dashboard removed — root now lands on Live Monitoring.
dashboardRouter.get('/', requireAuth, async (_req, res) => {
  res.redirect('/monitoring');
});

// Live monitoring (Phase 2 — advanced filters, column selection, saved views)
dashboardRouter.get('/monitoring', requireAuth, requirePermission(PERMISSION.MONITORING_VIEW), async (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere(filter, scope);
  const page = Number(req.query.page ?? 1);
  const pageSize = Math.min(Number(req.query.pageSize ?? 25), 200);
  const { field, dir } = safeSort(req.query.sortBy as string, req.query.sortDir as string);
  const data = await dash.listRegistrationsWhere(where, page, pageSize, field, dir);

  // Resolve visible columns: query > saved user preference > defaults.
  let requested = req.query.columns ? String(req.query.columns).split(',').filter(Boolean) : undefined;
  if (!requested) {
    const pref = await getTablePreference(req.principal!.userId, 'registrations');
    if (pref?.columns?.length) requested = pref.columns;
  }
  const columns = resolveColumns(requested);

  const [subjects, schools, views] = await Promise.all([
    prisma.subject.findMany({ orderBy: { name: 'asc' } }),
    prisma.school.findMany({ where: scope ? { id: { in: scope }, deletedAt: null } : { deletedAt: null }, orderBy: { name: 'asc' } }),
    listViews(req.principal!.userId, 'registrations'),
  ]);

  res.render('monitoring', {
    title: 'Live Monitoring', principal: req.principal, data, subjects, schools,
    query: req.query, nav: 'monitoring',
    columns, allColumns: REGISTRATION_COLUMNS, selectedKeys: columns.map((c) => c.key),
    canUnmaskPii: req.principal!.permissions.has(PERMISSION.PII_UNMASK),
    savedViews: views.map(hydrateView), filterQuery: filterToQuery(filter),
  });
});

// Schools Dashboard
dashboardRouter.get('/schools', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere(filter, scope);
  const [kpis, schoolsTable, subjectsTable, byGrade, durations, scores, trends, cis, statusDist, health] = await Promise.all([
    dash.kpiBlock(where),
    dash.schoolsSummary(where),
    dash.subjectsSummary(where),
    dash.completionByGrade(where),
    dash.durationsBySubject(where),
    dash.scoresBySubject(where),
    dash.completionTrends(where),
    dash.correctIncorrectSkipped(where),
    dash.statusDistribution(where),
    dash.apiHealth(),
  ]);
  const subjects = await prisma.subject.findMany({ orderBy: { name: 'asc' } });
  res.render('schools', {
    title: 'Schools Dashboard', principal: req.principal, nav: 'schools', query: req.query,
    kpis, schoolsTable, subjectsTable, byGrade, durations, scores, trends, cis, statusDist,
    errorDist: health.errorDistribution, subjects,
  });
});

// School Details
dashboardRouter.get('/schools/:id', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  if (scope && !scope.includes(req.params.id)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Not in your school scope', principal: req.principal });
  }
  const school = await prisma.school.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!school) return res.status(404).render('error', { title: 'Not found', message: 'School not found', principal: req.principal });

  const filter = parseFilter(req.query as Record<string, unknown>);
  const where = buildRegistrationWhere({ ...filter, schoolId: req.params.id }, scope);
  const [kpis, bySubject, byGrade, trends, cis, statusDist, students] = await Promise.all([
    dash.kpiBlock(where),
    dash.subjectsSummary(where),
    dash.completionByGrade(where),
    dash.completionTrends(where),
    dash.correctIncorrectSkipped(where),
    dash.statusDistribution(where),
    dash.listRegistrationsWhere(where, Number(req.query.page ?? 1), 25, 'updatedAt', 'desc'),
  ]);
  res.render('school-detail', {
    title: `School — ${school.name}`, principal: req.principal, nav: 'schools', query: req.query,
    school, kpis, bySubject, byGrade, trends, cis, statusDist, students,
  });
});

// Subject Dashboard
dashboardRouter.get('/subjects', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const scope = schoolScopeFor(req.principal!);
  const where = buildRegistrationWhere(filter, scope);
  const [subjectsTable, health] = await Promise.all([dash.subjectsSummary(where), dash.apiHealth()]);
  res.render('subjects', {
    title: 'Subject Dashboard', principal: req.principal, nav: 'subjects', query: req.query,
    subjectsTable, workspaces: health.workspaces,
  });
});

// Subject Details
dashboardRouter.get('/subjects/:subject', requireAuth, requirePermission(PERMISSION.DASHBOARD_VIEW), async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  const examSubject = decodeURIComponent(req.params.subject);
  const filter = parseFilter(req.query as Record<string, unknown>);
  const where = buildRegistrationWhere({ ...filter, examSubject }, scope);
  const [kpis, bySchool, byGrade, scoresBySchool, durations, dist, trends, cis, statusDist, workspace] = await Promise.all([
    dash.kpiBlock(where),
    dash.schoolsSummary(where),
    dash.completionByGrade(where),
    dash.scoresBySchool(where),
    dash.durationsBySubject(where),
    dash.scoreDistribution(where),
    dash.completionTrends(where),
    dash.correctIncorrectSkipped(where),
    dash.statusDistribution(where),
    dash.workspaceHealthForSubject(examSubject),
  ]);
  res.render('subject-detail', {
    title: `Subject — ${examSubject}`, principal: req.principal, nav: 'subjects', query: req.query,
    examSubject, kpis, bySchool, byGrade, scoresBySchool, durations, dist, trends, cis, statusDist, workspace,
  });
});

// Student / registration details
dashboardRouter.get('/registrations/:id', requireAuth, requirePermission(PERMISSION.STUDENT_VIEW), async (req, res) => {
  const reg = await prisma.examRegistration.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      student: true, school: true, subject: true, workspace: true,
      results: { include: { scores: true }, orderBy: { createdAt: 'desc' } },
      statusSnapshots: { orderBy: { fetchedAt: 'desc' }, take: 5 },
    },
  });
  if (!reg) return res.status(404).render('error', { title: 'Not found', message: 'Registration not found', principal: req.principal });

  const scope = schoolScopeFor(req.principal!);
  if (scope && reg.schoolId && !scope.includes(reg.schoolId)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Not in your school scope', principal: req.principal });
  }

  const canSeeRaw = req.principal!.permissions.has(PERMISSION.RAW_RESPONSE_VIEW);
  const canUnmaskPii = req.principal!.permissions.has(PERMISSION.PII_UNMASK);
  res.render('student', { title: 'Student Details', principal: req.principal, reg, canSeeRaw, canUnmaskPii, nav: 'monitoring' });
});
