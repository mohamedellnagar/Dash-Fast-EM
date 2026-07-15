import { z } from 'zod';
import { prisma } from '../db/prisma';
import { COLUMN_KEYS } from './columns';

export const PAGE_TYPES = ['registrations', 'schools', 'subjects', 'attention'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  pageType: z.enum(PAGE_TYPES),
  filters: z.record(z.any()).default({}),
  sortBy: z.string().max(60).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  columns: z.array(z.string().max(60)).default([]),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  isDefault: z.boolean().default(false),
  isShared: z.boolean().default(false),
});
export type SavedViewInput = z.infer<typeof savedViewSchema>;

// Only persist known column keys (defends against arbitrary input).
function sanitizeColumns(cols: string[]): string[] {
  return cols.filter((c) => COLUMN_KEYS.includes(c));
}

/** Views visible to a user for a page: their own + shared. */
export async function listViews(userId: string, pageType: string) {
  return prisma.savedView.findMany({
    where: { pageType, deletedAt: null, OR: [{ userId }, { isShared: true }] },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
}

export async function getView(id: string, userId: string) {
  const v = await prisma.savedView.findFirst({ where: { id, deletedAt: null } });
  if (!v) return null;
  if (v.userId !== userId && !v.isShared) return null; // private to owner
  return v;
}

export async function getDefaultView(userId: string, pageType: string) {
  // Prefer the user's own default; fall back to a shared default.
  const own = await prisma.savedView.findFirst({
    where: { pageType, deletedAt: null, isDefault: true, userId },
  });
  if (own) return own;
  return prisma.savedView.findFirst({
    where: { pageType, deletedAt: null, isDefault: true, isShared: true },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createView(userId: string, input: SavedViewInput, canShare: boolean) {
  const isShared = input.isShared && canShare;
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.savedView.updateMany({ where: { userId, pageType: input.pageType, isDefault: true }, data: { isDefault: false } });
    }
    return tx.savedView.create({
      data: {
        userId, name: input.name, description: input.description ?? null, pageType: input.pageType,
        filtersJson: JSON.stringify(input.filters ?? {}),
        sortBy: input.sortBy ?? null, sortDir: input.sortDir ?? null,
        columnsJson: JSON.stringify(sanitizeColumns(input.columns ?? [])),
        pageSize: input.pageSize, isDefault: input.isDefault, isShared,
      },
    });
  });
}

export async function updateView(id: string, userId: string, input: Partial<SavedViewInput>, canShare: boolean) {
  const existing = await prisma.savedView.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) return null; // only owner may edit
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.savedView.updateMany({ where: { userId, pageType: existing.pageType, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.savedView.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        filtersJson: input.filters ? JSON.stringify(input.filters) : undefined,
        sortBy: input.sortBy ?? undefined,
        sortDir: input.sortDir ?? undefined,
        columnsJson: input.columns ? JSON.stringify(sanitizeColumns(input.columns)) : undefined,
        pageSize: input.pageSize ?? undefined,
        isDefault: input.isDefault ?? undefined,
        isShared: input.isShared !== undefined ? input.isShared && canShare : undefined,
      },
    });
  });
}

export async function duplicateView(id: string, userId: string) {
  const src = await getView(id, userId);
  if (!src) return null;
  return prisma.savedView.create({
    data: {
      userId, name: `${src.name} (copy)`, description: src.description, pageType: src.pageType,
      filtersJson: src.filtersJson, sortBy: src.sortBy, sortDir: src.sortDir,
      columnsJson: src.columnsJson, pageSize: src.pageSize, isDefault: false, isShared: false,
    },
  });
}

export async function setDefault(id: string, userId: string) {
  const v = await prisma.savedView.findFirst({ where: { id, userId, deletedAt: null } });
  if (!v) return null;
  return prisma.$transaction(async (tx) => {
    await tx.savedView.updateMany({ where: { userId, pageType: v.pageType, isDefault: true }, data: { isDefault: false } });
    return tx.savedView.update({ where: { id }, data: { isDefault: true } });
  });
}

export async function deleteView(id: string, userId: string) {
  const v = await prisma.savedView.findFirst({ where: { id, userId, deletedAt: null } });
  if (!v) return null;
  return prisma.savedView.update({ where: { id }, data: { deletedAt: new Date() } });
}

/** Parse a stored view into a usable shape. */
export function hydrateView(v: any) {
  return {
    id: v.id, name: v.name, description: v.description, pageType: v.pageType,
    filters: safeJson(v.filtersJson, {}), sortBy: v.sortBy, sortDir: v.sortDir,
    columns: safeJson(v.columnsJson, []), pageSize: v.pageSize,
    isDefault: v.isDefault, isShared: v.isShared,
  };
}

function safeJson(s: string, fallback: any) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// --- per-user table preferences (independent of saved views) ---------------

export async function getTablePreference(userId: string, pageType: string) {
  const p = await prisma.userTablePreference.findUnique({ where: { userId_pageType: { userId, pageType } } });
  return p ? { columns: safeJson(p.columnsJson, []), pageSize: p.pageSize } : null;
}

export async function saveTablePreference(userId: string, pageType: string, columns: string[], pageSize: number) {
  return prisma.userTablePreference.upsert({
    where: { userId_pageType: { userId, pageType } },
    create: { userId, pageType, columnsJson: JSON.stringify(sanitizeColumns(columns)), pageSize },
    update: { columnsJson: JSON.stringify(sanitizeColumns(columns)), pageSize },
  });
}
