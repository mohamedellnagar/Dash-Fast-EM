// Parses a FastTest results payload into normalized result + score rows and
// derives calculated fields. Unknown fields are NOT discarded — the complete
// raw payload is persisted alongside for diagnostics/forward compatibility.
//
// IMPORTANT: We never fabricate DateCompleted/TimeCompleted/Attempted/TestCode/
// Status from the results endpoint. Attempted is CALCULATED (correct+incorrect).

export interface ParsedScore {
  examineeTestId?: string;
  subscore?: string;
  name?: string;
  rawScore?: number;
  sumScore?: number;
  cutScore?: number;
  scaledScore?: number;
  correct?: number;
  incorrect?: number;
  skipped?: number;
  totalCorrect?: number;
  totalIncorrect?: number;
  totalSkipped?: number;
  rawJson: string;
}

export interface ParsedResult {
  firstName?: string;
  lastName?: string;
  externalId?: string;
  examineeId?: string;
  email?: string;
  registrationDate?: string;
  testName?: string;
  startTime?: string;
  secondsUsed?: number;
  passed?: boolean;
  testSessionId?: string;
  testSessionName?: string;
  examineeGroupId?: string;
  examineeGroupPath?: string;
  constructorUrl?: string;
  attemptedItems?: number;
  totalItemsCount?: number;
  completionPercentage?: number;
  durationFormatted?: string;
  startDate?: string;
  startTimeOnly?: string;
  scores: ParsedScore[];
  rawJson: string;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function splitDateTime(startTime: string | undefined): { startDate?: string; startTimeOnly?: string } {
  if (!startTime) return {};
  // Accept ISO-ish "2026-07-13T09:30:00" or "2026-07-13 09:30:00".
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(startTime.trim());
  if (m) return { startDate: m[1], startTimeOnly: m[2] };
  return {};
}

function parseScore(raw: any): ParsedScore {
  const scored = raw?.scoredItems ?? {};
  const total = raw?.totalItems ?? {};
  return {
    examineeTestId: raw?.examineeTestId != null ? String(raw.examineeTestId) : undefined,
    subscore: raw?.subscore != null ? String(raw.subscore) : undefined,
    name: raw?.name,
    rawScore: num(raw?.rawScore),
    sumScore: num(raw?.sumScore),
    cutScore: num(raw?.cutScore),
    scaledScore: num(raw?.scaledScore),
    correct: num(scored?.correct),
    incorrect: num(scored?.incorrect),
    skipped: num(scored?.skipped),
    totalCorrect: num(total?.correct),
    totalIncorrect: num(total?.incorrect),
    totalSkipped: num(total?.skipped),
    rawJson: JSON.stringify(raw ?? {}),
  };
}

export function parseResults(payload: any): ParsedResult {
  const regResults = Array.isArray(payload?.examineeRegistrationResults)
    ? payload.examineeRegistrationResults
    : [];
  const primary = regResults[0] ?? {};
  const rawScores = Array.isArray(primary?.scores) ? primary.scores : [];
  const scores = rawScores.map(parseScore);

  // Aggregate item counts across scores for the calculated fields.
  let correct = 0;
  let incorrect = 0;
  let skipped = 0;
  let hasCounts = false;
  for (const s of scores) {
    if (s.correct !== undefined || s.incorrect !== undefined || s.skipped !== undefined) {
      hasCounts = true;
      correct += s.correct ?? 0;
      incorrect += s.incorrect ?? 0;
      skipped += s.skipped ?? 0;
    }
  }

  const attemptedItems = hasCounts ? correct + incorrect : undefined;
  const totalItemsCount = hasCounts ? correct + incorrect + skipped : undefined;
  const completionPercentage =
    totalItemsCount && totalItemsCount > 0 ? Math.round(((attemptedItems ?? 0) / totalItemsCount) * 10000) / 100 : undefined;

  const secondsUsed = num(primary?.secondsUsed);
  const startTime = primary?.startTime ?? primary?.startDate;
  const { startDate, startTimeOnly } = splitDateTime(startTime);

  return {
    firstName: payload?.firstName ?? primary?.firstName,
    lastName: payload?.lastName ?? primary?.lastName,
    externalId: payload?.externalId != null ? String(payload.externalId) : primary?.externalId,
    examineeId: payload?.examineeId != null ? String(payload.examineeId) : undefined,
    email: payload?.email,
    registrationDate: payload?.registrationDate,
    testName: primary?.testName,
    startTime,
    secondsUsed,
    passed: typeof primary?.passed === 'boolean' ? primary.passed : undefined,
    testSessionId: primary?.testSessionId != null ? String(primary.testSessionId) : undefined,
    testSessionName: primary?.testSessionName,
    examineeGroupId: primary?.examineeGroupId != null ? String(primary.examineeGroupId) : undefined,
    examineeGroupPath: primary?.examineeGroupPath,
    constructorUrl: primary?.constructorUrl,
    attemptedItems,
    totalItemsCount,
    completionPercentage,
    durationFormatted: formatDuration(secondsUsed),
    startDate,
    startTimeOnly,
    scores,
    rawJson: JSON.stringify(payload ?? {}),
  };
}
