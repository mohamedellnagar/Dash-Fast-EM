/**
 * FastTest timestamp conversion — US source clock to UAE local time.
 *
 * FastTest returns exam timestamps as a naive string with no timezone:
 *
 *   "startTime": "2025-10-07 06:58:44"
 *
 * FastTest confirmed the values are recorded on a US clock, so the reading is
 * interpreted in `sourceTimeZone` and converted to `displayTimeZone`. With the
 * default zones that is +9h in US summer and +10h in US winter — the gap is not
 * a constant, because the US observes DST and the UAE does not, so an IANA zone
 * name is used rather than a fixed offset. Set `FASTTEST_SOURCE_TZ=Etc/GMT+5`
 * to force a flat +9h year-round instead.
 *
 * The vendor also drops the AM/PM marker: across 71,589 stored records the hour
 * is always 01–12, never 00 and never 13–23. That is recovered from the daily
 * exam window when one is supplied — the window is 8 hours, so of the two
 * candidate readings 12 hours apart at most one can be a real sitting. Without a
 * window the reading is taken at face value.
 *
 * The vendor's original string is always preserved in `raw` (and in the
 * `startTime` column), so every value can be recomputed once FastTest returns an
 * unambiguous clock. See docs/fasttest-timestamp-issue.md.
 */

export const TIME_RESOLUTION = {
  /** Converted from the source zone at face value (no window supplied). */
  CONVERTED: 'CONVERTED',
  /** 12-hour reading placed in the morning by the exam window. */
  RESOLVED_AM: 'RESOLVED_AM',
  /** 12-hour reading placed in the afternoon by the exam window. */
  RESOLVED_PM: 'RESOLVED_PM',
  /** Resolved, but the sitting began after the window closed (a late start). */
  RESOLVED_LATE: 'RESOLVED_LATE',
  /** Neither reading is a credible sitting — no instant is produced. */
  AMBIGUOUS: 'AMBIGUOUS',
  /** The string already carried an explicit offset, so it needed no assumption. */
  EXPLICIT_OFFSET: 'EXPLICIT_OFFSET',
  /** Absent or not a timestamp. */
  UNPARSEABLE: 'UNPARSEABLE',
} as const;
export type TimeResolution = (typeof TIME_RESOLUTION)[keyof typeof TIME_RESOLUTION];

/** Resolutions that produced a trustworthy instant. */
export const RESOLVED_STATES: TimeResolution[] = [
  TIME_RESOLUTION.EXPLICIT_OFFSET,
  TIME_RESOLUTION.CONVERTED,
  TIME_RESOLUTION.RESOLVED_AM,
  TIME_RESOLUTION.RESOLVED_PM,
  TIME_RESOLUTION.RESOLVED_LATE,
];

/**
 * How long after the window closes a start is still credible. Sittings overrun:
 * a proctor admits a latecomer, a session is extended, a makeup runs on.
 */
const LATE_GRACE_MINUTES = 240;

/**
 * How long BEFORE the window opens a start is credible — essentially not at
 * all, beyond clock skew. This asymmetry is what makes the 12-hour clock
 * decidable: the two candidate readings are 12h apart, so when neither lands
 * inside the window one falls after it closes and the other before it opens.
 * A student cannot sit an exam that has not opened yet.
 */
const EARLY_TOLERANCE_MINUTES = 15;

/** "7:30:00" / "15:30" -> minutes past midnight. Null when unusable. */
export function parseWindowTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export interface ResolvedExamTime {
  /** The instant, in UTC. */
  utc: Date | null;
  resolution: TimeResolution;
  /** Wall-clock reading in the display zone, "YYYY-MM-DD HH:mm:ss". */
  displayLocal: string | null;
  /** Hour 0-23 in the display zone, for time-of-day analytics. */
  displayHour: number | null;
  /** The vendor's original string, never discarded. */
  raw: string | null;
  sourceTimeZone: string;
}

interface WallTime {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

const NAIVE_TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/;

function parseNaive(raw: string): WallTime | null {
  const m = NAIVE_TS.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: s ? +s : 0 };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) return null;
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
  return wall;
}

/**
 * Parse a timestamp that already carries a UTC offset ("Z" or "-05:00").
 * Returns null for the naive strings FastTest currently sends — this exists so
 * that the moment the vendor starts returning ISO 8601, it is honoured with no
 * code change and no assumption about their clock.
 */
function parseExplicitOffset(raw: string): Date | null {
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
  const d = new Date(t.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock reading of a UTC instant in a zone. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, // some engines render midnight as 24
    minute: get('minute'), second: get('second'),
  };
}

function asUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant.
 *
 * Two-pass because a zone's offset depends on the instant, which is what we are
 * solving for: guess by treating the wall time as UTC, measure the offset at
 * that guess, correct, then re-measure to catch a DST boundary crossed by the
 * first correction.
 */
export function zonedWallTimeToUtc(w: WallTime, timeZone: string): Date {
  const target = asUtcMs(w);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const offset = asUtcMs(wallTimeIn(new Date(guess), timeZone)) - guess;
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export interface ResolveOptions {
  raw: string | null | undefined;
  /** IANA zone the vendor's clock runs in (e.g. America/Chicago). */
  sourceTimeZone: string;
  /** IANA zone to render for operators (e.g. Asia/Dubai). */
  displayTimeZone: string;
  /**
   * Daily exam window in the DISPLAY zone ("7:30:00" / "15:30:00"). When given,
   * it recovers the AM/PM marker the vendor drops: the window is 8 hours, so of
   * the two readings 12 hours apart at most one can be a real sitting. Omit to
   * take the vendor's reading at face value.
   */
  windowStart?: string | null;
  windowEnd?: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Convert one FastTest timestamp into a UTC instant plus a UAE-local reading. */
export function resolveExamTime(opts: ResolveOptions): ResolvedExamTime {
  const raw = opts.raw ?? null;
  const base: ResolvedExamTime = {
    utc: null, resolution: TIME_RESOLUTION.UNPARSEABLE,
    displayLocal: null, displayHour: null, raw, sourceTimeZone: opts.sourceTimeZone,
  };
  if (!raw) return base;

  const finish = (instant: Date, resolution: TimeResolution): ResolvedExamTime => {
    const l = wallTimeIn(instant, opts.displayTimeZone);
    return {
      utc: instant,
      resolution,
      displayLocal: `${l.year}-${pad2(l.month)}-${pad2(l.day)} ${pad2(l.hour)}:${pad2(l.minute)}:${pad2(l.second)}`,
      displayHour: l.hour,
      raw,
      sourceTimeZone: opts.sourceTimeZone,
    };
  };

  // An explicit offset needs no assumption about the vendor's clock.
  const explicit = parseExplicitOffset(String(raw));
  if (explicit) return finish(explicit, TIME_RESOLUTION.EXPLICIT_OFFSET);

  const wall = parseNaive(String(raw));
  if (!wall) return base;

  const winStart = parseWindowTime(opts.windowStart);
  const winEnd = parseWindowTime(opts.windowEnd);

  // No window supplied, or a reading that can only be 24-hour: take it as sent.
  if (winStart === null || winEnd === null || wall.hour === 0 || wall.hour > 12) {
    return finish(zonedWallTimeToUtc(wall, opts.sourceTimeZone), TIME_RESOLUTION.CONVERTED);
  }

  // The vendor drops AM/PM, so a 1..12 reading has two candidates 12h apart.
  // The exam window is 8 hours, so at most one of them can be a real sitting.
  const amHour = wall.hour === 12 ? 0 : wall.hour;   // 12:xx AM is 00:xx
  const pmHour = wall.hour === 12 ? 12 : wall.hour + 12;
  const candidates = [
    { instant: zonedWallTimeToUtc({ ...wall, hour: amHour }, opts.sourceTimeZone), resolution: TIME_RESOLUTION.RESOLVED_AM },
    { instant: zonedWallTimeToUtc({ ...wall, hour: pmHour }, opts.sourceTimeZone), resolution: TIME_RESOLUTION.RESOLVED_PM },
  ];

  const circular = (from: number, to: number) => (to - from < 0 ? to - from + 1440 : to - from);
  const scored = candidates.map((c) => {
    const l = wallTimeIn(c.instant, opts.displayTimeZone);
    const mins = l.hour * 60 + l.minute;
    const inside = mins >= winStart && mins <= winEnd;
    return {
      ...c,
      inside,
      lateBy: inside ? 0 : circular(winEnd, mins),
      earlyBy: inside ? 0 : circular(mins, winStart),
    };
  });

  const inside = scored.filter((c) => c.inside);
  if (inside.length === 1) return finish(inside[0].instant, inside[0].resolution);
  // Both inside would need a window >= 12h wide; this one is 8h, so it cannot
  // happen with the real data — but do not guess if a wider window is ever set.
  if (inside.length === 2) return { ...base, resolution: TIME_RESOLUTION.AMBIGUOUS };

  // Neither landed inside. A sitting may overrun the close but cannot begin
  // before the exam opens, so only a late reading is credible.
  const credible = scored.filter(
    (c) => c.lateBy <= LATE_GRACE_MINUTES && c.earlyBy > EARLY_TOLERANCE_MINUTES,
  );
  if (credible.length === 1) return finish(credible[0].instant, TIME_RESOLUTION.RESOLVED_LATE);

  return { ...base, resolution: TIME_RESOLUTION.AMBIGUOUS };
}

/** Render a stored UTC instant in the display zone. */
export function formatInZone(instant: Date | null | undefined, timeZone: string): string | null {
  if (!instant) return null;
  const w = wallTimeIn(instant, timeZone);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

/**
 * The zone's UTC offset as a MySQL-compatible string, e.g. "+04:00".
 *
 * Needed because this deployment's MySQL has no timezone tables loaded, so
 * CONVERT_TZ() by IANA name returns NULL and only numeric offsets work. Safe
 * for Asia/Dubai, which is +04:00 year-round; `zoneObservesDst` lets callers
 * detect a display zone where a single offset would be wrong part of the year.
 */
export function utcOffsetString(timeZone: string, at: Date = new Date()): string {
  const offsetMs = asUtcMs(wallTimeIn(at, timeZone)) - Math.floor(at.getTime() / 1000) * 1000;
  const total = Math.round(offsetMs / 60000);
  const sign = total < 0 ? '-' : '+';
  const abs = Math.abs(total);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** True when the zone's offset changes across the year (i.e. it observes DST). */
export function zoneObservesDst(timeZone: string, year = new Date().getUTCFullYear()): boolean {
  return utcOffsetString(timeZone, new Date(Date.UTC(year, 0, 15)))
    !== utcOffsetString(timeZone, new Date(Date.UTC(year, 6, 15)));
}

/** Hours between two zones at a given instant, for display ("+9h"). */
export function offsetHoursBetween(sourceTz: string, displayTz: string, at: Date = new Date()): number {
  const diff = asUtcMs(wallTimeIn(at, displayTz)) - asUtcMs(wallTimeIn(at, sourceTz));
  return Math.round((diff / 3_600_000) * 100) / 100;
}

/** True when the runtime's zone database recognises the name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zones offered for the per-workspace source setting: the ones FastTest is known
 * to use, plus fixed-offset equivalents for a deployment that wants no DST.
 */
export const SOURCE_TIMEZONE_CHOICES = [
  'UTC',
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'Etc/GMT+5', // UTC-5 fixed, no DST
  'Etc/GMT+6', // UTC-6 fixed, no DST
  'Asia/Dubai',
] as const;
