import { describe, it, expect } from 'vitest';
import { normalizeTestCode, buildTestCode } from '../../src/lib/testcode';

describe('TestCode normalization', () => {
  it('removes hyphens and uppercases', () => {
    expect(normalizeTestCode('FUJ-290-263-565')).toBe('FUJ290263565');
  });
  it('removes spaces and trims', () => {
    expect(normalizeTestCode('  abc 123 ')).toBe('ABC123');
  });
  it('handles null/undefined/empty', () => {
    expect(normalizeTestCode(null)).toBe('');
    expect(normalizeTestCode(undefined)).toBe('');
    expect(normalizeTestCode('')).toBe('');
  });
  it('preserves the original while normalizing', () => {
    const r = buildTestCode('  fuj-290-263-565 ');
    expect(r.testCodeOriginal).toBe('fuj-290-263-565');
    expect(r.testCodeNormalized).toBe('FUJ290263565');
  });
  it('is idempotent', () => {
    const once = normalizeTestCode('FUJ-290');
    expect(normalizeTestCode(once)).toBe(once);
  });
});
