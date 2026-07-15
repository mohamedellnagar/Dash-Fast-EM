import { describe, it, expect } from 'vitest';
import { parseFilter, buildRegistrationWhere, safeSort, filterToQuery } from '../../src/services/filters';

function flatten(where: any): any[] {
  return where.AND ?? [];
}

describe('Advanced filters', () => {
  it('parses and drops empty values', () => {
    const f = parseFilter({ studentId: 'S1', grade: '', search: '  x  ' });
    expect(f.studentId).toBe('S1');
    expect(f.grade).toBeUndefined();
    expect(f.search).toBe('x'); // trimmed
  });

  it('coerces numeric ranges', () => {
    const f = parseFilter({ scoreMin: '10', scoreMax: '90', durationMin: '60' });
    expect(f.scoreMin).toBe(10);
    expect(f.scoreMax).toBe(90);
    expect(f.durationMin).toBe(60);
  });

  it('always ANDs deletedAt: null', () => {
    const where = buildRegistrationWhere({});
    expect(flatten(where)[0]).toEqual({ deletedAt: null });
  });

  it('enforces school scope server-side (non-bypassable)', () => {
    const where = buildRegistrationWhere({ schoolId: 'attacker-school' }, ['allowed-1', 'allowed-2']);
    const clauses = flatten(where);
    expect(clauses).toContainEqual({ schoolId: { in: ['allowed-1', 'allowed-2'] } });
    // user-supplied schoolId is still applied but AND-combined with the scope
    expect(clauses).toContainEqual({ schoolId: 'attacker-school' });
  });

  it('empty scope array blocks all rows', () => {
    const where = buildRegistrationWhere({}, []);
    expect(flatten(where)).toContainEqual({ schoolId: { in: ['__none__'] } });
  });

  it('normalizes testCode search to compact uppercase', () => {
    const where = buildRegistrationWhere({ testCode: 'fuj-290' });
    expect(flatten(where)).toContainEqual({ testCodeNormalized: { contains: 'FUJ290' } });
  });

  it('supports multi-status via CSV', () => {
    const where = buildRegistrationWhere({ status: 'COMPLETED,IN_PROGRESS' });
    expect(flatten(where)).toContainEqual({ dashboardStatus: { in: ['COMPLETED', 'IN_PROGRESS'] } });
  });

  it('builds score/duration range as a results relation filter', () => {
    const where = buildRegistrationWhere({ scoreMin: 50, durationMax: 3600 });
    const rel = flatten(where).find((c) => c.results);
    expect(rel.results.some.rawScore.gte).toBe(50);
    expect(rel.results.some.secondsUsed.lte).toBe(3600);
  });

  it('maps apiError to error/manual-review sync statuses', () => {
    const where = buildRegistrationWhere({ apiError: '1' });
    expect(flatten(where)).toContainEqual({ syncStatus: { in: ['ERROR', 'MANUAL_REVIEW'] } });
  });

  it('safeSort allow-lists columns and defaults safely', () => {
    expect(safeSort('studentExternalId', 'asc')).toEqual({ field: 'studentExternalId', dir: 'asc' });
    expect(safeSort('DROP TABLE', 'asc')).toEqual({ field: 'updatedAt', dir: 'asc' });
    expect(safeSort(undefined, 'weird')).toEqual({ field: 'updatedAt', dir: 'desc' });
  });

  it('serializes a filter back to a query string', () => {
    const q = filterToQuery({ studentId: 'S1', status: 'COMPLETED' } as any);
    expect(q).toContain('studentId=S1');
    expect(q).toContain('status=COMPLETED');
  });
});
