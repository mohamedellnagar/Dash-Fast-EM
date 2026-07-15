import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import { prisma } from '../../src/db/prisma';
import { runExport, listExportHistory } from '../../src/services/export.service';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';

let wsId: string;
let schoolA: string;
let schoolB: string;

beforeAll(async () => {
  wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Export WS', subjectCode: 'EXPORT', baseUrl: 'https://x.test/api' } })).id;
});

beforeEach(async () => {
  await clearRegistrations();
  schoolA = (await makeSchool('Exp School A')).id;
  schoolB = (await makeSchool('Exp School B')).id;
  await makeRegistration({ schoolId: schoolA, examSubject: 'Math', status: 'COMPLETED', workspaceId: wsId, result: { rawScore: 18, correct: 15, incorrect: 3, skipped: 2 } });
  await makeRegistration({ schoolId: schoolA, examSubject: 'Math', status: 'NOT_STARTED', studentExternalId: '=DANGER()' }); // formula-injection attempt in data
  await makeRegistration({ schoolId: schoolB, examSubject: 'Arabic', status: 'COMPLETED', workspaceId: wsId, result: { rawScore: 20, correct: 20, incorrect: 0, skipped: 0 } });
});

function readCsv(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1 }) as string[][];
}

const ctx = () => ({ userId: undefined, actorEmail: 'tester@t.local', canUnmaskPii: false, scopeSchoolIds: undefined });

describe('Export service', () => {
  it('exports all records as CSV and records history', async () => {
    const out = await runExport('ALL', 'csv', {}, undefined, undefined, undefined, ctx());
    expect(out.count).toBe(3);
    expect(out.contentType).toContain('text/csv');
    const jobs = await prisma.exportJob.findMany({ where: { exportType: 'ALL' } });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].status).toBe('COMPLETED');
    expect(jobs[0].recordCount).toBe(3);
  });

  it('COMPLETED preset filters to completed rows only', async () => {
    const out = await runExport('COMPLETED', 'csv', {}, undefined, undefined, undefined, ctx());
    expect(out.count).toBe(2);
  });

  it('neutralizes formula-injection in exported cell values', async () => {
    const out = await runExport('ALL', 'csv', {}, ['StudentId'], undefined, undefined, ctx());
    const rows = readCsv(out.buffer);
    const flat = rows.flat().join('|');
    expect(flat).toContain("'=DANGER()"); // prefixed, neutralized
    expect(flat).not.toMatch(/(^|\|)=DANGER\(\)/); // never a bare formula
  });

  it('enforces school scope on exports', async () => {
    const out = await runExport('ALL', 'csv', {}, undefined, undefined, undefined, { ...ctx(), scopeSchoolIds: [schoolB] });
    expect(out.count).toBe(1); // only School B row
  });

  it('produces a school summary preset', async () => {
    const out = await runExport('SCHOOL_SUMMARY', 'xlsx', {}, undefined, undefined, undefined, ctx());
    expect(out.count).toBe(2); // two schools
    expect(out.contentType).toContain('spreadsheetml');
  });

  it('lists export history', async () => {
    await runExport('ALL', 'csv', {}, undefined, undefined, undefined, ctx());
    const hist = await listExportHistory(undefined, true, 10);
    expect(hist.length).toBeGreaterThan(0);
  });
});
