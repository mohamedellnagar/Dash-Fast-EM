#!/usr/bin/env bash
# Provision a throwaway SQLite database for the automated test run so tests
# never touch dev data. DATABASE_URL is resolved by Prisma relative to the
# prisma/ directory, so this becomes prisma/test.db.
set -euo pipefail
export DATABASE_URL="file:./test.db"
rm -f prisma/test.db prisma/test.db-journal
npx prisma migrate deploy >/dev/null
npx ts-node --transpile-only prisma/seed.ts >/dev/null
echo "test database ready (prisma/test.db)"
