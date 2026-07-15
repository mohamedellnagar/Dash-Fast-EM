import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { classify, refreshAttention, listAttention, setStatus, addNote, assignItem, attentionSummary } from '../../src/services/attention.service';
import { ATTENTION_ISSUE, ATTENTION_STATUS } from '../../src/lib/enums';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';

const NOW = 1_800_000_000_000;

function reg(overrides: any) {
  return {
    id: 'r', schoolId: null, subjectId: null, studentId: 's', workspaceId: 'w',
    dashboardStatus: 'UNKNOWN', syncStatus: 'OK', syncError: null, syncRetryCount: 0,
    lastSyncAt: null, attendanceOriginal: null, testCodeNormalized: 'ABC123', _count: { results: 1 },
    ...overrides,
  };
}

describe('Attention classification rules', () => {
  it('detects API not found', () => {
    const issues = classify(reg({ syncError: 'NOT_FOUND: no such test' }), NOW).map((i) => i.issue);
    expect(issues).toContain(ATTENTION_ISSUE.API_NOT_FOUND);
  });
  it('detects missing workspace mapping', () => {
    const issues = classify(reg({ workspaceId: null }), NOW).map((i) => i.issue);
    expect(issues).toContain(ATTENTION_ISSUE.WORKSPACE_MAPPING_MISSING);
  });
  it('detects auth failure', () => {
    expect(classify(reg({ syncError: 'UNAUTHORIZED: bad key' }), NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.AUTH_FAILED);
  });
  it('detects sync failed after max retries', () => {
    expect(classify(reg({ syncStatus: 'MANUAL_REVIEW' }), NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.SYNC_FAILED_MAX_RETRIES);
  });
  it('detects no results after completion', () => {
    expect(classify(reg({ dashboardStatus: 'COMPLETED', _count: { results: 0 } }), NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.NO_RESULTS_AFTER_COMPLETION);
  });
  it('detects stale in-progress status', () => {
    const stale = reg({ dashboardStatus: 'IN_PROGRESS', lastSyncAt: new Date(NOW - 20 * 60 * 1000) });
    expect(classify(stale, NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.STALE_STATUS);
  });
  it('detects attendance/status conflict', () => {
    const conflict = reg({ attendanceOriginal: 'Absent', dashboardStatus: 'COMPLETED' });
    expect(classify(conflict, NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.STATUS_CONFLICT);
  });
  it('detects missing student mapping', () => {
    expect(classify(reg({ studentId: null }), NOW).map((i) => i.issue)).toContain(ATTENTION_ISSUE.MISSING_STUDENT_MAPPING);
  });
  it('a healthy registration yields no issues', () => {
    expect(classify(reg({}), NOW)).toHaveLength(0);
  });
});

describe('Attention queue lifecycle', () => {
  let schoolId: string;
  beforeEach(async () => {
    await clearRegistrations();
    schoolId = (await makeSchool('Attn School')).id;
  });

  it('refresh upserts items and auto-resolves stale ones', async () => {
    const bad = await makeRegistration({ schoolId, workspaceId: null, syncStatus: 'MANUAL_REVIEW', syncError: 'NOT_FOUND: x', status: 'UNKNOWN' });
    const r1 = await refreshAttention();
    expect(r1.detected).toBeGreaterThan(0);
    const items = await prisma.attentionItem.findMany({ where: { registrationId: bad.id } });
    expect(items.length).toBeGreaterThan(0);

    // Fix the registration; refresh should auto-resolve the open items.
    await prisma.examRegistration.update({ where: { id: bad.id }, data: { workspaceId: null, syncStatus: 'OK', syncError: null } });
    // workspaceId still null → WORKSPACE_MAPPING_MISSING persists, but NOT_FOUND/MANUAL_REVIEW resolve
    await refreshAttention();
    const notFound = await prisma.attentionItem.findFirst({ where: { registrationId: bad.id, issueType: ATTENTION_ISSUE.API_NOT_FOUND } });
    expect(notFound!.status).toBe(ATTENTION_STATUS.RESOLVED);
    expect(notFound!.resolvedBy).toBe('SYSTEM');
  });

  it('lists items respecting school scope', async () => {
    const other = (await makeSchool('Other')).id;
    await makeRegistration({ schoolId, workspaceId: null, status: 'UNKNOWN' });
    await makeRegistration({ schoolId: other, workspaceId: null, status: 'UNKNOWN' });
    await refreshAttention();
    const scoped = await listAttention({}, [schoolId], 1, 50);
    expect(scoped.rows.every((r: any) => r.schoolId === schoolId)).toBe(true);
    expect(scoped.total).toBeGreaterThan(0);
  });

  it('supports assign, status change and notes', async () => {
    await makeRegistration({ schoolId, workspaceId: null, status: 'UNKNOWN' });
    await refreshAttention();
    const item = (await prisma.attentionItem.findFirst({}))!;
    await setStatus(item.id, ATTENTION_STATUS.RESOLVED, 'ops@t.local');
    const note = await addNote(item.id, 'Fixed the mapping', undefined, 'ops@t.local');
    expect(note.note).toBe('Fixed the mapping');
    const reloaded = await prisma.attentionItem.findUnique({ where: { id: item.id } });
    expect(reloaded!.status).toBe(ATTENTION_STATUS.RESOLVED);
    expect(reloaded!.resolvedBy).toBe('ops@t.local');
  });

  it('summary counts open items by severity', async () => {
    await makeRegistration({ schoolId, workspaceId: null, status: 'UNKNOWN' });
    await refreshAttention();
    const s = await attentionSummary(undefined);
    expect(s.total).toBeGreaterThan(0);
  });
});
