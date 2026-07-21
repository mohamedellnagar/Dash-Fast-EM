import { execSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

/**
 * Build/version identity shown in the UI and /health, so you can tell which
 * revision is actually running after a deploy.
 *
 * Resolution order (first non-empty wins):
 *   1. Env vars baked in at image build time — GIT_SHA / BUILD_TIME. The Docker
 *      build passes these as ARGs (the container has no .git to read from).
 *   2. `git` at runtime — works in local dev where the repo is present.
 *   3. package.json version only — last-resort fallback.
 */
function resolveSha(): string {
  const fromEnv = process.env.GIT_SHA || process.env.SOURCE_COMMIT || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function resolveBuildTime(): string {
  const fromEnv = process.env.BUILD_TIME;
  if (fromEnv) return fromEnv;
  try {
    // Last commit date — a stable proxy for build time in local dev.
    return execSync('git log -1 --format=%cI', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return new Date().toISOString();
  }
}

const semver = pkg.version;
const sha = resolveSha();
const buildTime = resolveBuildTime();
const buildDate = buildTime.slice(0, 10);

export const version = {
  semver,
  sha,
  buildTime,
  buildDate,
  /** Compact one-line label for the UI, e.g. "v0.1.0 · f912bbd · 2026-07-21". */
  label: `v${semver} · ${sha} · ${buildDate}`,
};
