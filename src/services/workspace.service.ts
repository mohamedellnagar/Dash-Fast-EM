import { prisma } from '../db/prisma';
import { decryptOrNull, maskSecret } from '../lib/crypto';
import { env } from '../config/env';
import { offsetHoursBetween, zoneObservesDst } from '../lib/exam-time';

/** Normalize a subject alias for matching (uppercase, collapse whitespace). */
export function normalizeAlias(alias: string | null | undefined): string {
  if (!alias) return '';
  return alias.trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface ResolvedWorkspace {
  workspaceId: string;
  workspaceName: string;
  subjectCode: string;
  baseUrl: string;
  restApiKey: string | null;
  username: string | null;
  password: string | null;
  tokenTTL: number;
  /** IANA zone this workspace's exam timestamps are recorded in (null = env default). */
  sourceTimeZone: string | null;
}

/**
 * Resolve the FastTest workspace for a given source ExamSubject.
 * Resolution order:
 *   1. Exact alias mapping (WorkspaceSubjectMapping.aliasNormalized)
 *   2. Fallback: workspace whose subjectCode matches the normalized subject
 * Returns null when no active workspace can serve the subject.
 */
export async function resolveWorkspaceBySubject(examSubject: string): Promise<ResolvedWorkspace | null> {
  const aliasNorm = normalizeAlias(examSubject);
  if (!aliasNorm) return null;

  const mapping = await prisma.workspaceSubjectMapping.findFirst({
    where: { aliasNormalized: aliasNorm, isActive: true },
    include: { workspace: true },
  });

  let workspace = mapping?.workspace ?? null;

  if (!workspace) {
    workspace = await prisma.fastTestWorkspace.findFirst({
      where: { subjectCode: aliasNorm, isActive: true, deletedAt: null },
    });
  }

  // Single-workspace fallback: when exactly one active workspace exists, route
  // every subject to it. This covers deployments that use one FastTest
  // workspace for all subjects and haven't set per-subject alias mappings —
  // otherwise unmapped subjects resolve to null and never sync.
  if (!workspace) {
    const actives = await prisma.fastTestWorkspace.findMany({
      where: { isActive: true, deletedAt: null },
      take: 2,
    });
    if (actives.length === 1) workspace = actives[0];
  }

  if (!workspace || !workspace.isActive || workspace.deletedAt) return null;

  return decryptWorkspace(workspace);
}

export async function getWorkspaceById(id: string): Promise<ResolvedWorkspace | null> {
  const ws = await prisma.fastTestWorkspace.findFirst({ where: { id, deletedAt: null } });
  return ws ? decryptWorkspace(ws) : null;
}

function decryptWorkspace(ws: {
  id: string;
  workspaceName: string;
  subjectCode: string;
  baseUrl: string;
  restApiKeyEncrypted: string | null;
  usernameEncrypted: string | null;
  passwordEncrypted: string | null;
  tokenTTL: number;
  sourceTimeZone: string | null;
}): ResolvedWorkspace {
  return {
    workspaceId: ws.id,
    workspaceName: ws.workspaceName,
    subjectCode: ws.subjectCode,
    baseUrl: ws.baseUrl,
    restApiKey: decryptOrNull(ws.restApiKeyEncrypted),
    username: decryptOrNull(ws.usernameEncrypted),
    password: decryptOrNull(ws.passwordEncrypted),
    tokenTTL: ws.tokenTTL,
    sourceTimeZone: ws.sourceTimeZone ?? null,
  };
}

/** Safe DTO for admin UI — secrets masked, never returned raw. */
export async function listWorkspacesMasked() {
  const rows = await prisma.fastTestWorkspace.findMany({
    where: { deletedAt: null },
    orderBy: { subjectCode: 'asc' },
    include: { rateLimit: true },
  });
  // Per-workspace rate limits fall back to the global env defaults when the
  // workspace has no override row yet (so the UI shows the effective values).
  const dflt = { maxRpm: env.rate.maxRpm, maxRps: env.rate.maxRps, maxConcurrent: env.rate.maxConcurrent };
  return rows.map((w) => ({
    id: w.id,
    workspaceName: w.workspaceName,
    subjectCode: w.subjectCode,
    baseUrl: w.baseUrl,
    isActive: w.isActive,
    syncEnabled: w.syncEnabled,
    tokenTTL: w.tokenTTL,
    sourceTimeZone: w.sourceTimeZone ?? null,
    sourceOffsetLabel: describeOffset(w.sourceTimeZone ?? env.fasttest.sourceTimezone, env.displayTimezone),
    restApiKeyMasked: maskSecret(decryptOrNull(w.restApiKeyEncrypted) ?? ''),
    hasApiKey: !!w.restApiKeyEncrypted,
    lastAuthenticationAt: w.lastAuthenticationAt,
    lastAuthenticationStatus: w.lastAuthenticationStatus,
    lastAuthenticationError: w.lastAuthenticationError,
    lastSuccessfulSyncAt: w.lastSuccessfulSyncAt,
    rateLimit: {
      maxRpm: w.rateLimit?.maxRpm ?? dflt.maxRpm,
      maxRps: w.rateLimit?.maxRps ?? dflt.maxRps,
      maxConcurrent: w.rateLimit?.maxConcurrent ?? dflt.maxConcurrent,
      isDefault: !w.rateLimit,
      autoTune: w.rateLimit?.autoTune ?? false,
    },
  }));
}

/** "+4h year-round" / "+9h summer / +10h winter", for the admin UI. */
function describeOffset(sourceTz: string, displayTz: string): string {
  const summer = offsetHoursBetween(sourceTz, displayTz, new Date(Date.UTC(2025, 6, 15)));
  const winter = offsetHoursBetween(sourceTz, displayTz, new Date(Date.UTC(2025, 11, 15)));
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return zoneObservesDst(sourceTz)
    ? `${sign(summer)}h summer / ${sign(winter)}h winter -> ${displayTz}`
    : `${sign(summer)}h year-round -> ${displayTz}`;
}
