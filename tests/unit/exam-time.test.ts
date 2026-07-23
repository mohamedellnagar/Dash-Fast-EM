import { describe, it, expect } from 'vitest';
import {
  resolveExamTime, zonedWallTimeToUtc, wallTimeIn, formatInZone,
  utcOffsetString, zoneObservesDst, offsetHoursBetween, TIME_RESOLUTION,
  isValidTimeZone, SOURCE_TIMEZONE_CHOICES,
} from '../../src/lib/exam-time';

const SRC = 'America/Chicago'; // FastTest's clock
const DISP = 'Asia/Dubai';     // ours

const convert = (raw: string, src = SRC) =>
  resolveExamTime({ raw, sourceTimeZone: src, displayTimeZone: DISP });

describe('US -> UAE conversion', () => {
  it('adds 9 hours during US summer time', () => {
    const r = convert('2025-10-07 06:58:44');
    expect(r.resolution).toBe(TIME_RESOLUTION.CONVERTED);
    expect(r.displayLocal).toBe('2025-10-07 15:58:44'); // 06:58 + 9h
    expect(r.displayHour).toBe(15);
  });

  it('adds 10 hours during US winter time', () => {
    // US DST ended 2 Nov 2025, so Chicago is UTC-6 and the gap widens by an hour.
    const r = convert('2025-11-05 06:58:44');
    expect(r.displayLocal).toBe('2025-11-05 16:58:44'); // 06:58 + 10h
  });

  it('proves the gap is not constant across the year', () => {
    expect(offsetHoursBetween(SRC, DISP, new Date('2025-07-15T00:00:00Z'))).toBe(9);
    expect(offsetHoursBetween(SRC, DISP, new Date('2025-12-15T00:00:00Z'))).toBe(10);
  });

  it('rolls the date when the conversion crosses midnight', () => {
    const r = convert('2025-10-07 20:30:00'); // +9h => 05:30 next day
    expect(r.displayLocal).toBe('2025-10-08 05:30:00');
  });

  it('supports a flat +9h year-round via a fixed-offset zone', () => {
    // Etc/GMT+5 is UTC-5 with no DST, so the gap to Dubai is always 9h.
    expect(offsetHoursBetween('Etc/GMT+5', DISP, new Date('2025-07-15T00:00:00Z'))).toBe(9);
    expect(offsetHoursBetween('Etc/GMT+5', DISP, new Date('2025-12-15T00:00:00Z'))).toBe(9);
    expect(convert('2025-11-05 06:58:44', 'Etc/GMT+5').displayLocal).toBe('2025-11-05 15:58:44');
  });

  it('stores the instant in UTC, not as a local string', () => {
    const r = convert('2025-10-07 06:58:44');
    expect(r.utc!.toISOString()).toBe('2025-10-07T11:58:44.000Z'); // 06:58 CDT
  });

  it('always keeps the vendor original', () => {
    expect(convert('2025-10-07 06:58:44').raw).toBe('2025-10-07 06:58:44');
  });
});

describe('DST boundaries', () => {
  it('handles the spring-forward gap', () => {
    const before = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 59, second: 0 }, SRC);
    const after = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0 }, SRC);
    expect(after.getTime() - before.getTime()).toBe(60_000);
  });

  it('handles the fall-back repeated hour', () => {
    // Wall clock 00:30 -> 03:00 spans 2.5h, but 3.5h of real time elapse.
    const a = zonedWallTimeToUtc({ year: 2025, month: 11, day: 2, hour: 0, minute: 30, second: 0 }, SRC);
    const b = zonedWallTimeToUtc({ year: 2025, month: 11, day: 2, hour: 3, minute: 0, second: 0 }, SRC);
    expect((b.getTime() - a.getTime()) / 3_600_000).toBe(3.5);
  });

  it('round-trips a wall time through UTC and back', () => {
    const wall = { year: 2026, month: 3, day: 20, hour: 9, minute: 15, second: 0 };
    expect(wallTimeIn(zonedWallTimeToUtc(wall, SRC), SRC)).toEqual(wall);
  });

  it('keeps Dubai at +04:00 all year', () => {
    expect(zoneObservesDst(DISP, 2025)).toBe(false);
    expect(utcOffsetString(DISP, new Date('2025-01-15T00:00:00Z'))).toBe('+04:00');
    expect(utcOffsetString(DISP, new Date('2025-07-15T00:00:00Z'))).toBe('+04:00');
  });

  it('detects that the source zone does observe DST', () => {
    expect(zoneObservesDst(SRC, 2025)).toBe(true);
  });
});

describe('forward compatibility', () => {
  it('honours an explicit offset instead of assuming the source zone', () => {
    const r = convert('2025-10-07T06:58:44Z');
    expect(r.resolution).toBe(TIME_RESOLUTION.EXPLICIT_OFFSET);
    expect(r.displayLocal).toBe('2025-10-07 10:58:44'); // 06:58Z + 4h
  });

  it('honours a numeric offset', () => {
    const r = convert('2025-10-07T06:58:44-05:00');
    expect(r.resolution).toBe(TIME_RESOLUTION.EXPLICIT_OFFSET);
    expect(r.utc!.toISOString()).toBe('2025-10-07T11:58:44.000Z');
  });

  it('accepts the ISO "T" separator on a naive string', () => {
    expect(convert('2025-10-07T06:58:44').resolution).toBe(TIME_RESOLUTION.CONVERTED);
  });
});

describe('unusable input', () => {
  it('reports UNPARSEABLE without inventing a value', () => {
    for (const bad of ['', 'N/A', 'not a date', null, undefined]) {
      const r = resolveExamTime({ raw: bad as any, sourceTimeZone: SRC, displayTimeZone: DISP });
      expect(r.resolution).toBe(TIME_RESOLUTION.UNPARSEABLE);
      expect(r.utc).toBeNull();
      expect(r.displayLocal).toBeNull();
    }
  });

  it('rejects an out-of-range clock', () => {
    expect(convert('2025-10-07 25:00:00').resolution).toBe(TIME_RESOLUTION.UNPARSEABLE);
    expect(convert('2025-13-07 10:00:00').resolution).toBe(TIME_RESOLUTION.UNPARSEABLE);
  });
});

describe('formatInZone', () => {
  it('renders a stored instant in the display zone', () => {
    expect(formatInZone(new Date('2025-10-07T11:58:44Z'), DISP)).toBe('2025-10-07 15:58:44');
    expect(formatInZone(null, DISP)).toBeNull();
  });
});

describe('recovering AM/PM from the exam window', () => {
  const WIN = { windowStart: '7:30:00', windowEnd: '15:30:00' };
  const withWindow = (raw: string, w = WIN) =>
    resolveExamTime({ raw, sourceTimeZone: SRC, displayTimeZone: DISP, ...w });

  it('places a morning reading inside the window', () => {
    // 01:00 CDT -> 10:00 Dubai (inside). The 13:00 alternative -> 22:00 (not).
    const r = withWindow('2025-09-30 01:00:00');
    expect(r.resolution).toBe(TIME_RESOLUTION.RESOLVED_AM);
    expect(r.displayLocal).toBe('2025-09-30 10:00:00');
  });

  it('recovers a PM reading the vendor sent without its marker', () => {
    // "11:41" as AM -> 20:41 Dubai (outside). As PM (23:41) -> 08:41 next day.
    const r = withWindow('2025-09-30 11:41:37');
    expect(r.resolution).toBe(TIME_RESOLUTION.RESOLVED_PM);
    expect(r.displayLocal).toBe('2025-10-01 08:41:37');
    expect(r.displayHour).toBe(8);
  });

  it('accepts a sitting that overran the close', () => {
    // NDC428522220: 06:58 -> 15:58 Dubai, 28 min past the window. The
    // alternative, 03:58, is before the exam opened and so is impossible.
    const r = withWindow('2025-10-07 06:58:44');
    expect(r.resolution).toBe(TIME_RESOLUTION.RESOLVED_LATE);
    expect(r.displayLocal).toBe('2025-10-07 15:58:44');
  });

  it('never places a sitting before the window opens', () => {
    for (const raw of ['2025-09-30 01:00:00', '2025-09-30 11:41:37', '2025-10-07 06:58:44']) {
      const r = withWindow(raw);
      expect(r.displayHour).toBeGreaterThanOrEqual(7);
    }
  });

  it('refuses to guess when the window cannot separate the readings', () => {
    const r = withWindow('2025-09-30 02:00:00', { windowStart: '0:00', windowEnd: '23:59' });
    expect(r.resolution).toBe(TIME_RESOLUTION.AMBIGUOUS);
    expect(r.utc).toBeNull();
    expect(r.raw).toBe('2025-09-30 02:00:00'); // original still preserved
  });

  it('falls back to face value when no window is supplied', () => {
    expect(convert('2025-09-30 11:41:37').resolution).toBe(TIME_RESOLUTION.CONVERTED);
  });

  it('takes a 24-hour reading at face value even with a window', () => {
    expect(withWindow('2025-09-30 22:15:00').resolution).toBe(TIME_RESOLUTION.CONVERTED);
  });
});

describe('per-workspace source zones', () => {
  // Verified against the FastTest portal: their timezone setting differs per
  // workspace, so one global zone mis-states half the estate by five hours.
  it('UTC workspaces convert +4 to Dubai all year', () => {
    // Math, SSS-338-270-530: API 05:27:18 -> portal 09:27 UAE.
    const r = resolveExamTime({
      raw: '2025-10-20 05:27:18', sourceTimeZone: 'UTC', displayTimeZone: DISP,
      windowStart: '7:30:00', windowEnd: '15:30:00',
    });
    expect(r.displayLocal).toBe('2025-10-20 09:27:18');
    expect(offsetHoursBetween('UTC', DISP, new Date('2025-12-15T00:00:00Z'))).toBe(4);
  });

  it('US Central workspaces follow DST', () => {
    // Baseline, NTP-067-191-643: API 06:12:15 on 2 Nov -> portal 16:12 UAE.
    // 2 Nov is the day US DST ends, so the gap is +10h, not +9h.
    const r = resolveExamTime({
      raw: '2025-11-02 06:12:15', sourceTimeZone: 'America/Chicago', displayTimeZone: DISP,
      windowStart: '7:30:00', windowEnd: '15:30:00',
    });
    expect(r.displayLocal).toBe('2025-11-02 16:12:15');
  });

  it('the same vendor string means different things per workspace', () => {
    const raw = '2025-10-20 05:27:18';
    const opts = { raw, displayTimeZone: DISP, windowStart: '7:30:00', windowEnd: '15:30:00' };
    const utcWs = resolveExamTime({ ...opts, sourceTimeZone: 'UTC' });
    const centralWs = resolveExamTime({ ...opts, sourceTimeZone: 'America/Chicago' });
    expect(utcWs.displayLocal).not.toBe(centralWs.displayLocal);
    expect(utcWs.displayHour).toBe(9);
    expect(centralWs.displayHour).toBe(14);
  });

  it('validates IANA zone names before they can be saved', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('offers only zones the runtime actually knows', () => {
    for (const tz of SOURCE_TIMEZONE_CHOICES) expect(isValidTimeZone(tz)).toBe(true);
  });
});
