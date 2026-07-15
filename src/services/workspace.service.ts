import { prisma } from '../db/prisma';
import { decryptOrNull, maskSecret } from '../lib/crypto';

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
  };
}

/** Safe DTO for admin UI — secrets masked, never returned raw. */
export async function listWorkspacesMasked() {
  const rows = await prisma.fastTestWorkspace.findMany({
    where: { deletedAt: null },
    orderBy: { subjectCode: 'asc' },
  });
  return rows.map((w) => ({
    id: w.id,
    workspaceName: w.workspaceName,
    subjectCode: w.subjectCode,
    baseUrl: w.baseUrl,
    isActive: w.isActive,
    syncEnabled: w.syncEnabled,
    tokenTTL: w.tokenTTL,
    restApiKeyMasked: maskSecret(decryptOrNull(w.restApiKeyEncrypted) ?? ''),
    hasApiKey: !!w.restApiKeyEncrypted,
    lastAuthenticationAt: w.lastAuthenticationAt,
    lastAuthenticationStatus: w.lastAuthenticationStatus,
    lastAuthenticationError: w.lastAuthenticationError,
    lastSuccessfulSyncAt: w.lastSuccessfulSyncAt,
  }));
}
