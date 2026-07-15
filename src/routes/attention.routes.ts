import { Router } from 'express';
import { z } from 'zod';
import { PERMISSION, ATTENTION_ISSUE, ATTENTION_STATUS, SEVERITY, ATTENTION_META } from '../lib/enums';
import { requireAuth, requirePermission, schoolScopeFor } from '../middleware/auth';
import * as attn from '../services/attention.service';
import { audit } from '../services/audit.service';

export const attentionRouter = Router();

const view = requirePermission(PERMISSION.ATTENTION_VIEW);
const manage = requirePermission(PERMISSION.ATTENTION_MANAGE);

// --- Page ---
// Students Requiring Attention page removed.
attentionRouter.get('/attention', requireAuth, (_req, res) => res.redirect('/monitoring'));

// --- JSON API ---
attentionRouter.get('/api/attention', requireAuth, view, async (req, res) => {
  const scope = schoolScopeFor(req.principal!);
  const data = await attn.listAttention(
    { status: req.query.status as string, severity: req.query.severity as string, issueType: req.query.issueType as string, schoolId: req.query.schoolId as string, assignedToUserId: req.query.assignedToUserId as string },
    scope, Number(req.query.page ?? 1), Math.min(Number(req.query.pageSize ?? 25), 200),
  );
  res.json(data);
});

attentionRouter.get('/api/attention/summary', requireAuth, view, async (req, res) => {
  res.json(await attn.attentionSummary(schoolScopeFor(req.principal!)));
});

// Recompute the queue from current DB state.
attentionRouter.post('/api/attention/refresh', requireAuth, manage, async (req, res) => {
  const result = await attn.refreshAttention();
  await audit({ userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'ATTENTION_REFRESH', detail: `detected=${result.detected} autoResolved=${result.autoResolved}`, ipAddress: req.ip });
  res.json(result);
});

attentionRouter.post('/api/attention/:id/assign', requireAuth, manage, async (req, res) => {
  const schema = z.object({ userId: z.string().nullable().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const item = await attn.assignItem(req.params.id, parsed.data.userId ?? null);
  res.json(item);
});

attentionRouter.post('/api/attention/:id/status', requireAuth, manage, async (req, res) => {
  const schema = z.object({ status: z.enum([ATTENTION_STATUS.OPEN, ATTENTION_STATUS.ACKNOWLEDGED, ATTENTION_STATUS.RESOLVED]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
  const item = await attn.setStatus(req.params.id, parsed.data.status, req.principal!.email);
  await audit({ userId: req.principal!.userId, actorEmail: req.principal!.email, action: 'ATTENTION_STATUS', entityType: 'AttentionItem', entityId: req.params.id, detail: parsed.data.status, ipAddress: req.ip });
  res.json(item);
});

attentionRouter.post('/api/attention/:id/notes', requireAuth, manage, async (req, res) => {
  const schema = z.object({ note: z.string().trim().min(1).max(2000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Note required' });
  const note = await attn.addNote(req.params.id, parsed.data.note, req.principal!.userId, req.principal!.email);
  res.status(201).json(note);
});
