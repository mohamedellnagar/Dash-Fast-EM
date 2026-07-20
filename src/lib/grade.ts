/**
 * Grade values arrive from the source in several shapes for the same grade:
 * "1", "Grade1", "grade 1", " Grade  1 ". Normalize them all to "Grade N" so
 * grouping (completion-by-grade, today's activity, filters) doesn't split.
 * Anything that isn't a recognizable numeric grade is kept as-is (trimmed).
 */
export function normalizeGrade(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const m = /^(?:grade\s*)?(\d{1,2})$/i.exec(s);
  return m ? `Grade ${Number(m[1])}` : s;
}
