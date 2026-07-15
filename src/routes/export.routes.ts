import { Router, Request } from 'express';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission, schoolScopeFor } from '../middleware/auth';
import { parseFilter } from '../services/filters';
import { runExport, listExportHistory, EXPORT_PRESETS, ExportPreset, ExportContext } from '../services/export.service';
import { audit } from '../services/audit.service';

export const exportRouter = Router();

function exportCtx(req: Request): ExportContext {
  return {
    userId: req.principal!.userId,
    actorEmail: req.principal!.email,
    canUnmaskPii: req.principal!.permissions.has(PERMISSION.PII_UNMASK),
    scopeSchoolIds: schoolScopeFor(req.principal!),
  };
}

async function handleExport(req: Request, res: any) {
  const presetKey = String(req.query.preset ?? 'CURRENT_FILTER').toUpperCase();
  const preset: ExportPreset = (presetKey in EXPORT_PRESETS ? presetKey : 'CURRENT_FILTER') as ExportPreset;
  const format = String(req.query.format) === 'xlsx' ? 'xlsx' : 'csv';
  const filter = parseFilter(req.query as Record<string, unknown>);
  const columns = req.query.columns ? String(req.query.columns).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const sortBy = req.query.sortBy as string | undefined;
  const sortDir = req.query.sortDir as string | undefined;

  const out = await runExport(preset, format, filter, columns, sortBy, sortDir, exportCtx(req));
  await audit({
    userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'EXPORT',
    entityType: 'ExportJob', detail: `preset=${preset} format=${format} count=${out.count}`, ipAddress: req.ip,
  });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.buffer);
}

// Primary export endpoint (server-rendered links + API both land here).
exportRouter.get('/export/registrations', requireAuth, requirePermission(PERMISSION.EXPORT_RUN), handleExport);
exportRouter.get('/api/registrations/export', requireAuth, requirePermission(PERMISSION.EXPORT_RUN), handleExport);

// Export history (JSON + page).
exportRouter.get('/api/export-jobs', requireAuth, requirePermission(PERMISSION.EXPORT_RUN), async (req, res) => {
  const isAdmin = req.principal!.permissions.has(PERMISSION.USER_MANAGE);
  res.json({ jobs: await listExportHistory(req.principal!.userId, isAdmin) });
});

exportRouter.get('/export', requireAuth, requirePermission(PERMISSION.EXPORT_RUN), async (req, res) => {
  const isAdmin = req.principal!.permissions.has(PERMISSION.USER_MANAGE);
  const jobs = await listExportHistory(req.principal!.userId, isAdmin);
  res.render('export', { title: 'Reports & Export', principal: req.principal, nav: 'export', presets: EXPORT_PRESETS, jobs });
});
