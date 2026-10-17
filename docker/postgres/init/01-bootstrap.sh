#!/usr/bin/env bash
# Development and test bootstrap, run by the postgres image at container init.
# Applies docker/postgres/bootstrap.psql with fixed
# development passwords. Never use these passwords outside development and tests.
set -euo pipefail

BOOTSTRAP_FILE=/libredb/bootstrap.psql

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  -v owner_pw=libredb_owner_dev \
  -v platform_pw=libredb_platform_dev \
  -v studio_pw=libredb_studio_dev \
  -f "$BOOTSTRAP_FILE"

# Development only: libredb_owner has NOCREATEDB, and `prisma migrate dev`
# needs a shadow database it owns.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  -c 'CREATE DATABASE libredb_shadow OWNER libredb_owner'
