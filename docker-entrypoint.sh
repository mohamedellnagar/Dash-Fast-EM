#!/bin/sh
set -e

# Apply any pending database migrations before the app starts. Safe to run on
# every boot and on every replica — migrate deploy only applies un-applied
# migrations and is a no-op when the schema is current.
echo "[entrypoint] running prisma migrate deploy..."
npx prisma migrate deploy

# Hand off to the container command (web server or worker).
echo "[entrypoint] starting: $*"
exec "$@"
