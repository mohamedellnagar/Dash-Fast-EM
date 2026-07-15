import { describe, it, expect } from 'vitest';
import { parseResults, formatDuration } from '../../src/services/fasttest/results-mapper';

const SAMPLE = {
  firstName: 'Sara',
  lastName: 'Ahmed',
  externalId: 'STU-1',
  examineeId: 987,
  email: 's@example.com',
  registrationDate: '2026-07-10',
  examineeRegistrationResults: [
    {
      testName: 'Arabic Reading',
      startTime: '2026-07-13T09:15:00',
      secondsUsed: 3661,
      passed: true,
      testSessionId: 555,
      testSessionName: 'Session A',
      examineeGroupId: 12,
      examineeGroupPath: '/uae/fujairah',
      scores: [
        {
          examineeTestId: 1,
          name: 'Overall',
          rawScore: 18,
          scaledScore: 220,
          sumScore: 18,
          cutScore: 200,
          scoredItems: { correct: 15, incorrect: 3, skipped: 2 },
          totalItems: { correct: 15, incorrect: 3, skipped: 2 },
        },
      ],
    },
  ],
};

describe('Results mapper calculated fields', () => {
  it('formats durations as HH:MM:SS', () => {
    expect(formatDuration(3661)).toBe('01:01:01');
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(undefined)).toBeUndefined();
  });

  it('calculates attempted, total, and completion %', () => {
    const r = parseResults(SAMPLE);
    // attempted = correct + incorrect = 18; total = 20; completion = 90%
    expect(r.attemptedItems).toBe(18);
    expect(r.totalItemsCount).toBe(20);
    expect(r.completionPercentage).toBe(90);
  });

  it('extracts scores and passed flag', () => {
    const r = parseResults(SAMPLE);
    expect(r.passed).toBe(true);
    expect(r.scores[0].rawScore).toBe(18);
    expect(r.scores[0].scaledScore).toBe(220);
    expect(r.scores[0].correct).toBe(15);
  });

  it('splits startTime into date and time', () => {
    const r = parseResults(SAMPLE);
    expect(r.startDate).toBe('2026-07-13');
    expect(r.startTimeOnly).toBe('09:15:00');
  });

  it('does not fabricate missing fields', () => {
    const r = parseResults({ examineeRegistrationResults: [{ testName: 'X' }] });
    expect(r.attemptedItems).toBeUndefined();
    expect(r.completionPercentage).toBeUndefined();
    expect(r.passed).toBeUndefined();
  });

  it('preserves the complete raw payload', () => {
    const r = parseResults(SAMPLE);
    expect(JSON.parse(r.rawJson).firstName).toBe('Sara');
  });
});
