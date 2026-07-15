import { Router } from 'express';
import { z } from 'zod';
import { PERMISSION } from '../lib/enums';
import { requireAuth } from '../middleware/auth';
import * as sv from '../services/saved-views.service';
import { REGISTRATION_COLUMNS, DEFAULT_COLUMNS } from '../services/columns';

export const savedViewsRouter = Router();

savedViewsRouter.use(requireAuth); // any authenticated user manages their own views

// Column catalogue for the column-selector UI.
savedViewsRouter.get('/columns', (_req, res) => {
  res.json({ columns: REGISTRATION_COLUMNS.map((c) => ({ key: c.key, label: c.label, defaultVisible: c.defaultVisible })), defaults: DEFAULT_COLUMNS });
});

savedViewsRouter.get('/', async (req, res) => {
  const pageType = String(req.query.pageType ?? 'registrations');
  const views = await sv.listViews(req.principal!.userId, pageType);
  res.json({ views: views.map(sv.hydrateView) });
});

savedViewsRouter.get('/:id', async (req, res) => {
  const v = await sv.getView(req.params.id, req.principal!.userId);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(sv.hydrateView(v));
});

savedViewsRouter.post('/', async (req, res) => {
  const parsed = sv.savedViewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const canShare = req.principal!.permissions.has(PERMISSION.SAVED_VIEW_SHARE);
  const created = await sv.createView(req.principal!.userId, parsed.data, canShare);
  res.status(201).json(sv.hydrateView(created));
});

savedViewsRouter.put('/:id', async (req, res) => {
  const parsed = sv.savedViewSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const canShare = req.principal!.permissions.has(PERMISSION.SAVED_VIEW_SHARE);
  const updated = await sv.updateView(req.params.id, req.principal!.userId, parsed.data, canShare);
  if (!updated) return res.status(404).json({ error: 'Not found or not owner' });
  res.json(sv.hydrateView(updated));
});

savedViewsRouter.post('/:id/duplicate', async (req, res) => {
  const dup = await sv.duplicateView(req.params.id, req.principal!.userId);
  if (!dup) return res.status(404).json({ error: 'Not found' });
  res.status(201).json(sv.hydrateView(dup));
});

savedViewsRouter.post('/:id/default', async (req, res) => {
  const v = await sv.setDefault(req.params.id, req.principal!.userId);
  if (!v) return res.status(404).json({ error: 'Not found or not owner' });
  res.json(sv.hydrateView(v));
});

savedViewsRouter.delete('/:id', async (req, res) => {
  const v = await sv.deleteView(req.params.id, req.principal!.userId);
  if (!v) return res.status(404).json({ error: 'Not found or not owner' });
  res.json({ ok: true });
});

// Per-user table preferences (column config independent of saved views).
const prefsSchema = z.object({ pageType: z.string().max(40).default('registrations'), columns: z.array(z.string()).default([]), pageSize: z.coerce.number().int().min(1).max(200).default(25) });
savedViewsRouter.put('/prefs/table', async (req, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  await sv.saveTablePreference(req.principal!.userId, parsed.data.pageType, parsed.data.columns, parsed.data.pageSize);
  res.json({ ok: true });
});
