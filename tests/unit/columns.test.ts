import { describe, it, expect } from 'vitest';
import { resolveColumns, DEFAULT_COLUMNS, COLUMN_KEYS, maskEmiratesId, display } from '../../src/services/columns';

describe('Column registry & PII masking', () => {
  it('resolves default columns when none requested', () => {
    expect(resolveColumns().map((c) => c.key)).toEqual(DEFAULT_COLUMNS);
  });
  it('preserves requested order and ignores unknown keys', () => {
    const cols = resolveColumns(['ExamSubject', 'NOT_A_COLUMN', 'StudentId']);
    expect(cols.map((c) => c.key)).toEqual(['ExamSubject', 'StudentId']);
  });
  it('falls back to defaults when all requested are invalid', () => {
    expect(resolveColumns(['bogus']).map((c) => c.key)).toEqual(DEFAULT_COLUMNS);
  });
  it('exposes all documented columns', () => {
    for (const k of ['StudentId', 'NameArabic', 'RawScore', 'Attempted', 'TotalItems', 'CompletionPercentage', 'ApiError']) {
      expect(COLUMN_KEYS).toContain(k);
    }
  });
  it('masks Emirates ID unless permitted', () => {
    const eid = '784-1990-1234567-1';
    expect(maskEmiratesId(eid, true)).toBe(eid);
    expect(maskEmiratesId(eid, false)).toBe('***-****-*******-1');
    expect(maskEmiratesId(null, true)).toBeNull();
  });
  it('renders null as an em-dash and never coerces to 0', () => {
    expect(display(null)).toBe('—');
    expect(display(0)).toBe('0');
    expect(display(true)).toBe('Yes');
  });
});
