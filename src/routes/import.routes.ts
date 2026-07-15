import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../db/prisma';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { commitImport, parseFile, validateRows } from '../services/import/import.service';
import { audit } from '../services/audit.service';
import { logger } from '../lib/logger';

export const importRouter = Router();

const PROGRAM_TYPES = ['SPA', 'ABA'];
function normalizeProgramType(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return PROGRAM_TYPES.includes(s) ? s : null;
}

// In-memory upload, capped at 50MB. Only CSV/XLSX accepted.
const MAX_UPLOAD_MB = 50;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// Wrap multer so upload errors (file too large, too many files) render a clear
// 400 page instead of bubbling up as an unhandled 500.
function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `File is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`
            : `Upload error: ${err.message}`;
        return res.status(400).render('error', { title: 'Import', message, principal: req.principal });
      }
      if (err) return next(err);
      next();
    });
  };
}

// Import center page
importRouter.get('/import', requireAuth, requirePermission(PERMISSION.IMPORT_RUN), async (req, res) => {
  const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  res.render('import', { title: 'Import Center', principal: req.principal, jobs, result: null, nav: 'import' });
});

// Preview (validate only, no writes)
importRouter.post('/import/preview', requireAuth, requirePermission(PERMISSION.IMPORT_RUN), uploadSingle('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).render('error', { title: 'Import', message: 'No valid CSV/XLSX file uploaded', principal: req.principal });
    const { rows, missingColumns } = parseFile(req.file.buffer);
    if (missingColumns.length) {
      return res.status(400).render('error', { title: 'Import', message: `Missing required columns: ${missingColumns.join(', ')}`, principal: req.principal });
    }
    const outcome = validateRows(rows);
    const programType = normalizeProgramType(req.body?.programType);
    const summary = await commitImport(req.file.originalname, outcome, req.principal!.userId, true, programType);
    const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    res.render('import', { title: 'Import Center', principal: req.principal, jobs, result: { ...summary, preview: true }, nav: 'import' });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'import preview failed');
    res.status(500).render('error', { title: 'Import', message: `Preview failed: ${(e as Error).message}`, principal: req.principal });
  }
});

// Confirm/commit (upsert)
importRouter.post('/import/commit', requireAuth, requirePermission(PERMISSION.IMPORT_RUN), uploadSingle('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).render('error', { title: 'Import', message: 'No valid CSV/XLSX file uploaded', principal: req.principal });
    const { rows, missingColumns } = parseFile(req.file.buffer);
    if (missingColumns.length) {
      return res.status(400).render('error', { title: 'Import', message: `Missing required columns: ${missingColumns.join(', ')}`, principal: req.principal });
    }
    const outcome = validateRows(rows);
    const programType = normalizeProgramType(req.body?.programType);
    const summary = await commitImport(req.file.originalname, outcome, req.principal!.userId, false, programType);
    await audit({
      userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'IMPORT',
      entityType: 'ImportJob', entityId: summary.importJobId,
      detail: `created=${summary.created} updated=${summary.updated} failed=${summary.failed}`, ipAddress: req.ip,
    });
    const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    res.render('import', { title: 'Import Center', principal: req.principal, jobs, result: { ...summary, preview: false }, nav: 'import' });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'import commit failed');
    res.status(500).render('error', { title: 'Import', message: `Import failed: ${(e as Error).message}`, principal: req.principal });
  }
});

// Download error report for an import job (CSV)
importRouter.get('/import/:id/errors.csv', requireAuth, requirePermission(PERMISSION.IMPORT_RUN), async (req, res) => {
  const errors = await prisma.importError.findMany({ where: { importJobId: req.params.id }, orderBy: { rowNumber: 'asc' } });
  const header = 'rowNumber,column,value,message\n';
  const body = errors.map((e) => `${e.rowNumber},"${e.column ?? ''}","${(e.value ?? '').replace(/"/g, '""')}","${e.message.replace(/"/g, '""')}"`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.id}-errors.csv"`);
  res.send('﻿' + header + body); // UTF-8 BOM for Excel/Arabic
});
