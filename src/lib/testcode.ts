// TestCode normalization. Source TestCodes may contain hyphens/spaces and
// varying case (e.g. "FUJ-290-263-565"). FastTest APIs expect the compact
// upper-cased form (e.g. "FUJ290263565"). We always preserve the original.

export function normalizeTestCode(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  return input
    .replace(/[-\s]/g, '') // remove hyphens and whitespace
    .trim()
    .toUpperCase();
}

export interface NormalizedTestCode {
  testCodeOriginal: string;
  testCodeNormalized: string;
}

export function buildTestCode(input: string | null | undefined): NormalizedTestCode {
  const original = (input ?? '').trim();
  return {
    testCodeOriginal: original,
    testCodeNormalized: normalizeTestCode(original),
  };
}
