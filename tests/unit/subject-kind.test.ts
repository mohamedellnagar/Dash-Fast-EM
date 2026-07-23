import { describe, it, expect } from 'vitest';
import { subjectKind, isExamSubject, SUBJECT_KIND } from '../../src/lib/subject-kind';

describe('subject classification', () => {
  it('treats the real assessment papers as exams', () => {
    for (const s of ['Math', 'English Writing', 'English Reading', 'Arabic Writing',
      'Arabic Reading', 'Baseline Arabic 1', 'Baseline Arabic 2']) {
      expect(subjectKind(s), s).toBe(SUBJECT_KIND.EXAM);
    }
  });

  it('treats observation forms and parent surveys as instruments, not exams', () => {
    for (const s of ['Observation form', 'parent questions En', 'Parent Questions',
      'OBSERVATION FORM', ' observation form ']) {
      expect(subjectKind(s), s).toBe(SUBJECT_KIND.INSTRUMENT);
    }
  });

  it('defaults an unrecognised subject to EXAM so no paper is silently dropped', () => {
    // Counting an instrument as an exam is a visible inaccuracy; hiding a real
    // exam would conceal students who never sat it. Fail toward visibility.
    expect(subjectKind('Science Grade 9')).toBe(SUBJECT_KIND.EXAM);
    expect(subjectKind('')).toBe(SUBJECT_KIND.EXAM);
    expect(subjectKind(null)).toBe(SUBJECT_KIND.EXAM);
    expect(isExamSubject(undefined)).toBe(true);
  });
});
