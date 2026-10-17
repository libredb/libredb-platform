#!/bin/sh
# The entry point of the Platform image (docs/deploy/platform-runtime.md): one image, one subcommand per container.
#
#   serve            the web server, the default; refuses to start when MIGRATE_DATABASE_URL is set, because
#                    only the migrate container may receive the owner URL
#   migrate          the preflight, `prisma migrate deploy` with the pinned CLI, then the bundled seed
#   maintain         runs every scheduled task once (scripts/maintain.ts)
#   migrate-status   `prisma migrate status`
#   migrate-resolve  `prisma migrate resolve --rolled-back <name>` or `--applied <name>`, for Prisma's
#                    failed-migration state (P3009)
#
# Any other argument prints the usage and exits 64 (EX_USAGE).
set -eu

APP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
MIGRATOR_DIR="$APP_DIR/docker/migrator"
PRISMA_CLI="$MIGRATOR_DIR/node_modules/prisma/build/index.js"
PRISMA_CONFIG="$MIGRATOR_DIR/prisma.config.mjs"

usage() {
  cat >&2 <<'USAGE'
Usage: entrypoint.sh [serve | migrate | maintain | migrate-status | migrate-resolve (--rolled-back | --applied) <migration>]
USAGE
  exit 64
}

# The Prisma CLI of docker/migrator, pinned to the root's version; it connects with MIGRATE_DATABASE_URL only.
prisma() {
  node "$PRISMA_CLI" "$@" --config "$PRISMA_CONFIG"
}

cd "$APP_DIR"

command=${1:-serve}
[ $# -gt 0 ] && shift

case "$command" in
  serve)
    [ $# -eq 0 ] || usage
    if [ -n "${MIGRATE_DATABASE_URL+set}" ]; then
      echo "entrypoint: refusing to serve: MIGRATE_DATABASE_URL is set, and only the migrate container may receive the owner URL" >&2
      exit 1
    fi
    # Next.js's own SIGTERM handler exits without waiting for the scheduler; src/instrumentation-node.ts handles the
    # signals instead and stops the scheduler first.
    export NEXT_MANUAL_SIG_HANDLE=true
    exec node server.js
    ;;
  migrate)
    [ $# -eq 0 ] || usage
    node "$MIGRATOR_DIR/preflight.mjs"
    prisma migrate deploy
    exec node "$MIGRATOR_DIR/dist/seed.cjs"
    ;;
  maintain)
    [ $# -eq 0 ] || usage
    exec node "$MIGRATOR_DIR/dist/maintain.cjs"
    ;;
  migrate-status)
    [ $# -eq 0 ] || usage
    prisma migrate status
    ;;
  migrate-resolve)
    [ $# -eq 2 ] || usage
    case "$1" in
      --rolled-back | --applied) ;;
      *) usage ;;
    esac
    [ -n "$2" ] || usage
    prisma migrate resolve "$1" "$2"
    ;;
  *)
    usage
    ;;
esac
