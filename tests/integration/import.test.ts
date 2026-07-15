import { describe, it, expect } from 'vitest';
import { parseFile, validateRows, commitImport } from '../../src/services/import/import.service';
import { prisma } from '../../src/db/prisma';

function csvBuffer(rows: string[]): Buffer {
  return Buffer.from(rows.join('\n'), 'utf8');
}

const HEADER =
  'StudentId,NameArabic,NameEnglish,SchoolId,SchoolName,Grade,EmiratesId,ClassCode,ExamSubject,ExamName,StartDate,EndDate,StartTime,EndTime,TestCode,ProctorCode,AccessToken,AcademicYear,Attendance';

describe('Student data import', () => {
  it('detects missing required columns', () => {
    const buf = csvBuffer(['StudentId,Foo', 'S1,bar']);
    const { missingColumns } = parseFile(buf);
    expect(missingColumns).toContain('ExamSubject');
    expect(missingColumns).toContain('TestCode');
  });

  it('validates rows and flags errors without inserting invalid ones', () => {
    const buf = csvBuffer([
      HEADER,
      'S1,سارة,Sara,SCH1,School One,5,784-1990-1,5A,Arabic,Arabic Reading,2026-07-13,2026-07-14,09:00,10:00,FUJ-290-263-565,PC1,AT1,2025-2026,Present',
      // missing TestCode
      'S2,علي,Ali,SCH1,School One,5,784-1990-2,5A,Arabic,Arabic Reading,2026-07-13,2026-07-14,09:00,10:00,,PC2,AT2,2025-2026,Absent',
      // bad date
      'S3,ندى,Nada,SCH1,School One,5,784-1990-3,5A,English,English,not-a-date,2026-07-14,09:00,10:00,ABU-111-222,PC3,AT3,2025-2026,Present',
    ]);
    const { rows, missingColumns } = parseFile(buf);
    expect(missingColumns).toHaveLength(0);
    const outcome = validateRows(rows);
    expect(outcome.totalRows).toBe(3);
    // Only S1 is valid: S2 lacks TestCode, S3 has an invalid StartDate.
    expect(outcome.validRows.length).toBe(1);
    expect(outcome.errors.some((e) => e.column === 'TestCode')).toBe(true);
    expect(outcome.errors.some((e) => e.column === 'StartDate')).toBe(true);
    // normalization applied
    const s1 = outcome.validRows.find((r) => r.data.StudentId === 'S1')!;
    expect(s1.testCodeNormalized).toBe('FUJ290263565');
  });

  it('detects in-file duplicates', () => {
    const line = 'S9,x,X,SCH2,School Two,6,784-1,6B,Math,Math,2026-07-13,2026-07-14,09:00,10:00,DXB-1-2-3,PC,AT,2025,Present';
    const buf = csvBuffer([HEADER, line, line]);
    const outcome = validateRows(parseFile(buf).rows);
    expect(outcome.errors.some((e) => /Duplicate/.test(e.message))).toBe(true);
  });

  it('commits valid rows (create then update = upsert) and preserves attendance', async () => {
    const buf = csvBuffer([
      HEADER,
      'IMP1,محمد,Mohamed,SCHX,School X,7,784-9,7C,Arabic,Arabic Reading,2026-07-13,2026-07-14,09:00,10:00,SHJ-500-600,PC,AT,2025-2026,Present',
    ]);
    const outcome1 = validateRows(parseFile(buf).rows);
    const s1 = await commitImport('test1.csv', outcome1, undefined, false);
    expect(s1.created).toBe(1);

    const reg = await prisma.examRegistration.findFirst({ where: { studentExternalId: 'IMP1' } });
    expect(reg).not.toBeNull();
    expect(reg!.testCodeNormalized).toBe('SHJ500600');
    expect(reg!.attendanceOriginal).toBe('Present');
    // Arabic resolves to a workspace
    expect(reg!.workspaceId).not.toBeNull();

    // Re-import with a changed attendance → should update but NOT overwrite attendanceOriginal
    const buf2 = csvBuffer([
      HEADER,
      'IMP1,محمد,Mohamed,SCHX,School X,7,784-9,7C,Arabic,Arabic Reading,2026-07-13,2026-07-14,09:00,10:00,SHJ-500-600,PC,AT,2025-2026,Absent',
    ]);
    const outcome2 = validateRows(parseFile(buf2).rows);
    const s2 = await commitImport('test2.csv', outcome2, undefined, false);
    expect(s2.updated).toBe(1);
    const reg2 = await prisma.examRegistration.findFirst({ where: { studentExternalId: 'IMP1' } });
    expect(reg2!.attendanceOriginal).toBe('Present'); // preserved, not overwritten
  });
});
