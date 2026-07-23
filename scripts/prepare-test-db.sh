#!/usr/bin/env bash
# Provision a throwaway database for the automated test run so tests never
# touch dev data.
#
# The schema targets MySQL (prisma/schema.prisma), so the test database must be
# MySQL too — a SQLite file fails Prisma's datasource validation. By default we
# reuse the dev server's credentials against a separate `_test` schema; override
# with TEST_DATABASE_URL to point somewhere else (e.g. in CI).
set -euo pipefail

DATABASE_URL="$(node scripts/test-db-url.js)"

export DATABASE_URL

# Recreate the schema from scratch so each run starts clean.
npx prisma migrate reset --force --skip-seed --skip-generate >/dev/null
npx ts-node --transpile-only prisma/seed.ts >/dev/null
echo "test database ready ($(printf '%s' "$DATABASE_URL" | sed -E 's#//[^@]*@#//***@#'))"
