import { Router, Request } from 'express';
import { z } from 'zod';
import { PERMISSION } from '../lib/enums';
import { requireAuth, requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/async-handler';
import { audit } from '../services/audit.service';
import { listWorkspacesMasked } from '../services/workspace.service';
import { verifyByCode } from '../services/verify.service';
import {
  verifyTestCode,
  recentChecks,
  explainFailure,
  ManualVerificationResult,
} from '../services/manual-verification.service';

export const verifyRouter = Router();

const view = requirePermission(PERMISSION.MANUAL_VERIFICATION_VIEW);
const execute = requirePermission(PERMISSION.MANUAL_VERIFICATION_EXECUTE);

function can(req: Request, permission: string): boolean {
  return !!req.principal?.permissions.has(permission);
}

// Manual Verification page — read-only lookup/diagnostics for one TestCode.
verifyRouter.get('/verify', requireAuth, view, (req, res) => {
  res.render('verify', {
    title: 'Manual Verification',
    principal: req.principal,
    nav: 'verify',
    caps: {
      execute: can(req, PERMISSION.MANUAL_VERIFICATION_EXECUTE),
      sensitive: can(req, PERMISSION.MANUAL_VERIFICATION_VIEW_SENSITIVE),
      raw: can(req, PERMISSION.MANUAL_VERIFICATION_VIEW_RAW),
      export: can(req, PERMISSION.MANUAL_VERIFICATION_EXPORT),
      // Only an integration admin may aim credentials at a chosen workspace.
      overrideWorkspace: can(req, PERMISSION.INTEGRATION_MANAGE),
    },
  });
});

/** Workspaces for the manual-override selector. Never includes secrets. */
verifyRouter.get('/api/manual-verification/workspaces', requireAuth, view,
  asyncHandler(async (_req, res) => {
    const rows = await listWorkspacesMasked();
    res.json({
      workspaces: rows
        .filter((w) => w.isActive)
        .map((w) => ({ id: w.id, name: w.workspaceName, subject: w.subjectCode })),
    });
  }));

const lookupSchema = z.object({
  testCode: z.string().min(1).max(120),
  workspaceId: z.string().uuid().optional().nullable(),
  /** Set only when the user actively reveals masked values (audited separately). */
  revealSensitive: z.boolean().optional(),
});

/**
 * Read-only lookup. Never creates scheduling, registrations or TestCodes and
 * never mutates FastTest — it only issues GETs and reads the local row.
 */
verifyRouter.post('/api/manual-verification/test-code', requireAuth, execute,
  asyncHandler(async (req, res) => {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'A Test Code is required.' });
    }

    // A workspace override points real credentials at an operator-chosen
    // workspace, so it needs integration rights on top of execute.
    const wantsOverride = !!parsed.data.workspaceId;
    if (wantsOverride && !can(req, PERMISSION.INTEGRATION_MANAGE)) {
      return res.status(403).json({ success: false, error: 'Not permitted to choose a workspace manually.' });
    }

    // Masked values are only ever unmasked for holders of view_sensitive.
    const reveal = !!parsed.data.revealSensitive && can(req, PERMISSION.MANUAL_VERIFICATION_VIEW_SENSITIVE);

    const result = await verifyTestCode({
      testCode: parsed.data.testCode,
      workspaceId: parsed.data.workspaceId ?? null,
      revealSensitive: reveal,
      userId: req.principal!.userId,
    });

    // Raw payloads are a separate grant from running the check.
    if (!can(req, PERMISSION.MANUAL_VERIFICATION_VIEW_RAW)) stripRaw(result);

    await audit({
      userId: req.principal!.userId,
      actorEmail: req.principal!.email,
      action: 'MANUAL_VERIFICATION',
      entityType: 'Verification',
      entityId: result.normalizedTestCode || parsed.data.testCode,
      detail: auditLine(result),
      ipAddress: req.ip,
    });
    if (reveal) {
      await audit({
        userId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: 'MANUAL_VERIFICATION_SENSITIVE_REVEALED',
        entityType: 'Verification',
        entityId: result.normalizedTestCode,
        detail: `revealed masked local fields for ${result.normalizedTestCode}`,
        ipAddress: req.ip,
      });
    }

    res.json({
      ...result,
      explain: {
        status: explainFailure(result.fastTest.status.errorType, result.fastTest.status.httpCode),
        results: explainFailure(result.fastTest.results.errorType, result.fastTest.results.httpCode),
      },
      history: result.normalizedTestCode ? await recentChecks(result.normalizedTestCode, 10) : [],
    });
  }));

/** Recent checks for a code, without re-running the lookup. */
verifyRouter.get('/api/manual-verification/history/:code', requireAuth, view,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').replace(/[-\s]/g, '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'Test Code required' });
    res.json({ history: await recentChecks(code, 20) });
  }));

/** Audit hook for the client-side copy/download actions in the raw section. */
verifyRouter.post('/api/manual-verification/audit-export', requireAuth,
  requirePermission(PERMISSION.MANUAL_VERIFICATION_EXPORT),
  asyncHandler(async (req, res) => {
    const kind = String(req.body?.kind || 'unknown').slice(0, 40);
    const code = String(req.body?.testCode || '').slice(0, 120);
    await audit({
      userId: req.principal!.userId,
      actorEmail: req.principal!.email,
      action: kind === 'raw-copy' ? 'MANUAL_VERIFICATION_RAW_COPIED' : 'MANUAL_VERIFICATION_EXPORTED',
      entityType: 'Verification',
      entityId: code,
      detail: `${kind} for ${code}`,
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }));

/** Remove raw API payloads for users without the raw-response grant. */
function stripRaw(result: ManualVerificationResult): void {
  result.fastTest.status.data = null;
  result.fastTest.results.data = null;
  result.fastTest.status.url = null;
  result.fastTest.results.url = null;
  result.fastTest.status.errorBody = null;
  result.fastTest.results.errorBody = null;
}

function auditLine(r: ManualVerificationResult): string {
  const st = r.fastTest.status;
  const rs = r.fastTest.results;
  return [
    `verify ${r.normalizedTestCode}`,
    `workspace=${r.workspace?.name ?? 'unresolved'}`,
    `local=${r.localRecordFound ? 'found' : 'missing'}`,
    `status=${st.success ? `ok(${st.httpCode})` : `fail(${st.errorType ?? st.httpCode})`}`,
    `results=${rs.success ? `ok(${rs.httpCode})` : `fail(${rs.errorType ?? rs.httpCode})`}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Legacy endpoint, kept so existing links/scripts keep working. The upgraded
// page uses /api/manual-verification/test-code.
// ---------------------------------------------------------------------------
const verifySchema = z.object({
  testCode: z.string().min(1).max(120),
  examName: z.string().min(1).max(200),
});

verifyRouter.post('/api/verify', requireAuth, execute, asyncHandler(async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'testCode and examName are required' });

  const result = await verifyByCode(parsed.data);
  await audit({
    userId: req.principal!.userId,
    actorEmail: req.principal!.email,
    action: 'MANUAL_VERIFICATION',
    entityType: 'Verification',
    entityId: result.testCodeNormalized ?? parsed.data.testCode,
    detail: `verify(legacy) ${result.testCodeNormalized ?? '?'} / ${parsed.data.examName} → ${result.ok ? `status=${result.liveDashboardStatus}` : `error=${result.errorType}`}`,
    ipAddress: req.ip,
  });

  res.json(result);
}));
