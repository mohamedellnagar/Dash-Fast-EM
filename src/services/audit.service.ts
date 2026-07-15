import { prisma } from '../db/prisma';

export interface AuditEntry {
  userId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  detail?: string; // MUST NOT contain secrets, passwords, tokens or API keys
  ipAddress?: string;
}

/** Write an audit log entry. Never pass secrets in `detail`. */
export async function audit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      detail: entry.detail ?? null,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
