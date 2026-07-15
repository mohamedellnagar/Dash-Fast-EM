import { describe, it, expect } from 'vitest';
import { sanitizeCell, applyPreset } from '../../src/services/export.service';

describe('CSV/Excel formula-injection prevention', () => {
  it('neutralizes cells starting with formula characters', () => {
    expect(sanitizeCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(sanitizeCell('+1+1')).toBe("'+1+1");
    expect(sanitizeCell('-2')).toBe("'-2");
    expect(sanitizeCell('@cmd')).toBe("'@cmd");
  });
  it('leaves safe strings and numbers untouched', () => {
    expect(sanitizeCell('Sara Ahmed')).toBe('Sara Ahmed');
    expect(sanitizeCell(220)).toBe(220);
    expect(sanitizeCell(null)).toBe(null);
  });
});

describe('Export presets', () => {
  it('ALL clears the filter', () => {
    expect(applyPreset('ALL', { status: 'COMPLETED' } as any)).toEqual({});
  });
  it('CURRENT_FILTER keeps the base filter', () => {
    expect(applyPreset('CURRENT_FILTER', { grade: '5' } as any)).toEqual({ grade: '5' });
  });
  it('status presets set the dashboard status', () => {
    expect(applyPreset('COMPLETED', {} as any).status).toBe('COMPLETED');
    expect(applyPreset('IN_PROGRESS', {} as any).status).toBe('IN_PROGRESS');
  });
  it('API_ERRORS / SYNC_FAILURES set the apiError flag', () => {
    expect(applyPreset('API_ERRORS', {} as any).apiError).toBe('1');
    expect(applyPreset('SYNC_FAILURES', {} as any).apiError).toBe('1');
  });
});
