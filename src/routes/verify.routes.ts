import { Router } from 'express';
import { z } from 'zod';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit.service';
import { verifyByCode } from '../services/verify.service';

export const verifyRouter = Router();

// Verification page — enter TestCode + ExamName to probe FastTest (read-only).
verifyRouter.get('/verify', requireAuth, requirePermission(PERMISSION.MANUAL_SYNC), (req, res) => {
  res.render('verify', { title: 'Manual Verification', principal: req.principal, nav: 'verify' });
});

const verifySchema = z.object({
  testCode: z.string().min(1).max(120),
  examName: z.string().min(1).max(200),
});

// JSON probe endpoint. Never writes to the database.
verifyRouter.post('/api/verify', requireAuth, requirePermission(PERMISSION.MANUAL_SYNC), async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'testCode and examName are required' });

  const result = await verifyByCode(parsed.data);
  await audit({
    userId: req.principal!.userId,
    actorEmail: req.principal!.email,
    action: 'CONFIG_CHANGE',
    entityType: 'Verification',
    entityId: result.testCodeNormalized ?? parsed.data.testCode,
    detail: `verify ${result.testCodeNormalized ?? '?'} / ${parsed.data.examName} → ${result.ok ? `status=${result.liveDashboardStatus}${result.existsInDb ? ` inSync=${result.inSync}` : ' (not in DB)'}` : `error=${result.errorType}`}`,
    ipAddress: req.ip,
  });

  res.json(result);
});
