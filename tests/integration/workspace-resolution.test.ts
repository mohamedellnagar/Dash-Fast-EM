import { describe, it, expect } from 'vitest';
import { resolveWorkspaceBySubject, normalizeAlias } from '../../src/services/workspace.service';

// These rely on the seeded workspaces + aliases (Arabic/English/Math/Science).
describe('Workspace resolution by subject (seeded aliases)', () => {
  it('normalizes aliases consistently', () => {
    expect(normalizeAlias('  Arabic   Reading ')).toBe('ARABIC READING');
  });

  it('resolves multiple Arabic aliases to the Arabic workspace', async () => {
    for (const alias of ['Arabic', 'Arabic Reading', 'Arabic Writing', 'Arabic Language']) {
      const ws = await resolveWorkspaceBySubject(alias);
      expect(ws, `alias ${alias}`).not.toBeNull();
      expect(ws!.subjectCode).toBe('ARABIC');
    }
  });

  it('resolves Math aliases to the Mathematics workspace', async () => {
    const ws = await resolveWorkspaceBySubject('Maths');
    expect(ws).not.toBeNull();
    expect(ws!.subjectCode).toBe('MATH');
  });

  it('returns null for an unknown subject', async () => {
    expect(await resolveWorkspaceBySubject('Astrophysics')).toBeNull();
    expect(await resolveWorkspaceBySubject('')).toBeNull();
  });

  it('decrypts secrets into the resolved workspace (no ciphertext leak)', async () => {
    const ws = await resolveWorkspaceBySubject('Arabic');
    // seeded without a key in test env → null, but the field must be the
    // decrypted value (or null), never the "v1:" ciphertext.
    expect(ws!.restApiKey === null || !String(ws!.restApiKey).startsWith('v1:')).toBe(true);
  });
});
