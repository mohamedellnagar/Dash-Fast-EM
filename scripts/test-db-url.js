// Single source of truth for the test database URL.
//
// The Prisma schema targets MySQL, so tests need a MySQL database — not the old
// SQLite file, which fails datasource validation. Default: the dev connection
// from .env with the database name suffixed `_test`, so tests get their own
// schema without a second set of credentials. Override with TEST_DATABASE_URL.
const fs = require('fs');
const path = require('path');

function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const envPath = path.join(__dirname, '..', '.env');
  const line = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))
    : undefined;
  if (!line) throw new Error('No TEST_DATABASE_URL and no DATABASE_URL in .env');

  const dev = line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
  // Suffix the database name, keeping host/credentials and any query string.
  return dev.replace(/\/([^/?]+)(\?.*)?$/, '/$1_test$2');
}

module.exports = { testDatabaseUrl };

if (require.main === module) process.stdout.write(testDatabaseUrl());
