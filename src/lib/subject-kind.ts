/**
 * What kind of instrument a FastTest "subject" actually is.
 *
 * The subject list mixes real assessments (Math, Arabic Reading, the Baseline
 * papers) with data-collection instruments that are not exams at all — a
 * teacher observation form and a parent questionnaire. Averaging them together
 * misreports exam delivery in both directions: the parent survey's ~30% return
 * rate reads as a failed exam rollout, and it drags the headline completion
 * rate well below the real figure for papers students actually sat.
 *
 * Classification is by name because FastTest does not expose a type. Anything
 * unrecognised is treated as an EXAM: over-counting an instrument as an exam is
 * a visible inaccuracy, whereas silently dropping a real exam from the delivery
 * numbers would hide students who never sat.
 */
export const SUBJECT_KIND = {
  EXAM: 'EXAM',
  INSTRUMENT: 'INSTRUMENT',
} as const;
export type SubjectKind = (typeof SUBJECT_KIND)[keyof typeof SUBJECT_KIND];

/**
 * Non-assessment instruments, matched case-insensitively as substrings.
 * Exported so SQL-level filters can be built from the same list instead of
 * drifting from the in-memory classifier.
 */
export const INSTRUMENT_PATTERNS = [
  'observation form',
  'observation',
  'parent question',
  'parent survey',
  'questionnaire',
];

export function subjectKind(examSubject: string | null | undefined): SubjectKind {
  const name = String(examSubject ?? '').trim().toLowerCase();
  if (!name) return SUBJECT_KIND.EXAM;
  return INSTRUMENT_PATTERNS.some((p) => name.includes(p))
    ? SUBJECT_KIND.INSTRUMENT
    : SUBJECT_KIND.EXAM;
}

export function isExamSubject(examSubject: string | null | undefined): boolean {
  return subjectKind(examSubject) === SUBJECT_KIND.EXAM;
}
