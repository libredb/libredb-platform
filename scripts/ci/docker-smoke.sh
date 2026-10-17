#!/usr/bin/env bash
# The smoke test of the Platform image (docs/deploy/platform-runtime.md), run by the docker-smoke job of
# .github/workflows/ci.yml.
#
# It builds the target `runner` of the Dockerfile and checks that the image carries the repository's LICENSE at
# /app/LICENSE and the label org.opencontainers.image.licenses=Elastic-2.0, that it holds no TypeScript source, test or
# markdown file outside node_modules, and in its two node_modules trees no declaration, source map, TypeScript source,
# test or markdown file, no Prisma query compiler of another database provider than the schema's and no sharp build
# for another libc, that its migrator tree holds none of the paths docker/migrator/prisma-cli-prune.txt deletes, and
# that its own sharp build loads. Then, on a private Docker network, it:
#   1. starts PostgreSQL with docker/postgres/bootstrap.psql and a server certificate from a throwaway CA, accepting
#      remote clients over TLS only, and Keycloak with the fixture realm, which `maintain` reads as directory sync;
#   2. runs `migrate` twice, with a Prisma-syntax MIGRATE_DATABASE_URL that carries sslcert and sslaccept=strict;
#   3. runs `serve`, the default, until GET /api/health/live and GET /api/health/ready answer 200, and checks that
#      GET /_next/image of a PNG answers 404, because the image optimizer is off;
#   4. runs `maintain` and `migrate-status`, which must exit 0;
#   5. marks the newest migration failed, after which `migrate` must stop with P3009, then runs
#      `migrate-resolve --rolled-back` and `migrate-resolve --applied` on it and `migrate-status`, which must exit 0;
#   6. runs an unknown argument, which must exit 64.
# It publishes no host port, so runs on one host never collide; the probes run inside the serve container.
# Everything it starts is removed on exit, and the logs of its containers are printed when a step fails.
#
# Environment, all optional:
#   SMOKE_NAME             prefix of every container and of the network (default libredb-smoke)
#   SMOKE_IMAGE            tag of the image it builds (default libredb-platform:smoke)
#   SMOKE_POSTGRES_MAJOR   PostgreSQL major version (default 18; 15 is the minimum, docs/deploy/platform-runtime.md)
#   SMOKE_TIMEOUT_SECONDS  how long each wait lasts before the smoke fails (default 180)
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
NAME=${SMOKE_NAME:-libredb-smoke}
IMAGE=${SMOKE_IMAGE:-libredb-platform:smoke}
POSTGRES_IMAGE=postgres:${SMOKE_POSTGRES_MAJOR:-18}
# The Keycloak version of docker-compose.test.yml, the one the installer ships.
KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.1
TIMEOUT=${SMOKE_TIMEOUT_SECONDS:-180}

NETWORK=$NAME-net
POSTGRES=$NAME-postgres
KEYCLOAK=$NAME-keycloak
SERVE=$NAME-serve
CA_DIR=/etc/libredb/ca

WORK=$(mktemp -d)
failed=1

log() {
  printf 'docker-smoke: %s\n' "$*" >&2
}

fail() {
  log "FAILED: $*"
  exit 1
}

cleanup() {
  if [ "$failed" -ne 0 ]; then
    for container in "$POSTGRES" "$KEYCLOAK" "$SERVE"; do
      if docker container inspect "$container" > /dev/null 2>&1; then
        log "logs of $container:"
        docker logs --tail 200 "$container" >&2 2>&1 || true
      fi
    done
    if [ "$(docker container inspect -f '{{.State.Running}}' "$SERVE" 2> /dev/null)" = true ]; then
      log 'GET /api/health/ready answers:'
      docker exec "$SERVE" node -e "
        fetch('http://127.0.0.1:' + process.env.PORT + '/api/health/ready')
          .then(async response => console.error(response.status, await response.text()))
      " || true
    fi
  fi
  docker rm -f "$SERVE" "$KEYCLOAK" "$POSTGRES" > /dev/null 2>&1 || true
  docker network rm "$NETWORK" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Retries `$@` once a second until it succeeds; fails when `container` stops or after TIMEOUT seconds.
wait_for() {
  local what=$1 container=$2
  shift 2
  local deadline=$((SECONDS + TIMEOUT))
  until "$@" > /dev/null 2>&1; do
    if [ "$(docker container inspect -f '{{.State.Running}}' "$container")" != true ]; then
      fail "$container stopped while waiting for $what"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "$what not reached within $TIMEOUT s"
    fi
    sleep 1
  done
  log "$what"
}

# Exits 0 when GET <path> on the serve container answers 200.
probe() {
  docker exec "$SERVE" node -e "
    fetch('http://127.0.0.1:' + process.env.PORT + process.argv[1])
      .then(response => process.exit(response.status === 200 ? 0 : 1), () => process.exit(1))
  " "$1"
}

keycloak_ready() {
  docker exec "$KEYCLOAK" bash -c "exec 3<>/dev/tcp/127.0.0.1/9000 &&
    printf 'GET /health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3 &&
    grep -q '\"status\": \"UP\"' <&3"
}

# Runs a one-shot container of the image on the smoke network with the CA mounted.
run_image() {
  docker run --rm --network "$NETWORK" -v "$WORK/ca:$CA_DIR:ro" "$@"
}

log "building $IMAGE (target runner)"
docker build --target runner -t "$IMAGE" "$ROOT"

# The Elastic License 2.0 travels with the image, and the label names it for registries and scanners.
log 'checking that the image carries LICENSE at /app/LICENSE and the license label'
licenses=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$IMAGE")
[ "$licenses" = Elastic-2.0 ] || fail "the label org.opencontainers.image.licenses is '$licenses', not Elastic-2.0"
docker run --rm --entrypoint cat "$IMAGE" /app/LICENSE | cmp -s - "$ROOT/LICENSE" \
  || fail '/app/LICENSE is missing from the image or differs from LICENSE'

# The server runs the compiled chunks, so such a file outside node_modules was traced or copied by mistake.
log 'checking the image for TypeScript sources, tests and markdown outside node_modules'
stray=$(docker run --rm --entrypoint find "$IMAGE" /app -path '*/node_modules' -prune -o -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.test.*' -o -name '*.spec.*' -o -name '*.md' \) -print)
[ -z "$stray" ] || fail "the image holds files the server never runs:"$'\n'"$stray"

# The packages keep only the files they load (docker/prune-node-modules.sh). Allowed: license and notice texts in
# markdown, because the licenses require them to travel with the code.
log 'checking both node_modules trees for declarations, source maps, TypeScript sources, tests and markdown'
stray=$(docker run --rm --entrypoint find "$IMAGE" /app/node_modules /app/docker/migrator/node_modules \
  -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \
  -o -name '*.map' -o -name '*.test.*' -o -name '*.spec.*' \
  -o \( \( -iname '*.md' -o -iname '*.markdown' \) ! -iname 'licen[cs]e*' ! -iname 'notice*' \) \) -print)
[ -z "$stray" ] || fail "node_modules holds $(wc -l <<< "$stray") files no package loads, such as:"$'\n'"$(head -20 <<< "$stray")"
# The test directories go by the prune's own rule, so these are its two finds with echo in place of rm: a test, docs or
# example directory whose parent holds a package.json, and a test-utils directory without a package.json of its own.
# A package named test-utils and a subpackage such as preact/test-utils hold one, so they stay.
log 'checking both node_modules trees for the test directories that the prune deletes'
stray=$(docker run --rm -i --entrypoint sh "$IMAGE" -s /app/node_modules /app/docker/migrator/node_modules <<'TEST_DIRS'
find "$@" -type d \( -name __tests__ -o -name test -o -name tests -o -name doc -o -name docs -o -name example \
  -o -name examples \) -prune \
  -exec sh -c 'for dir; do if [ -f "$dir/../package.json" ]; then echo "$dir"; fi; done' sh {} +
find "$@" -type d -name test-utils -prune \
  -exec sh -c 'for dir; do if [ ! -f "$dir/package.json" ]; then echo "$dir"; fi; done' sh {} +
TEST_DIRS
)
[ -z "$stray" ] || fail "node_modules holds test directories that docker/prune-node-modules.sh deletes:"$'\n'"$stray"

# The commands never open most of the Prisma CLI's dependencies, which the migrator's tree loses; the steps below run
# every command without them. A `*` of a listed path expands inside the image.
log 'checking that the migrator tree holds none of the paths docker/migrator/prisma-cli-prune.txt deletes'
stray=$(sed -n 's/^delete //p' "$ROOT/docker/migrator/prisma-cli-prune.txt" \
  | docker run --rm -i --entrypoint sh "$IMAGE" -c 'cd /app/docker/migrator/node_modules &&
      while read -r entry; do for path in $entry; do if [ -e "$path" ]; then echo "$path"; fi; done; done')
[ -z "$stray" ] || fail "the migrator tree holds paths that docker/migrator/prisma-cli-prune.txt deletes:"$'\n'"$stray"

# Prisma's query compilers come once per database provider, and the image keeps those of the schema's datasource only.
provider=$(sed -n '/^datasource /,/^}/ s/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\([a-z0-9]*\)".*/\1/p' \
  "$ROOT/prisma/schema.prisma")
[ -n "$provider" ] || fail 'prisma/schema.prisma names no datasource provider'
log "checking that both node_modules trees hold no Prisma query compiler but the $provider ones"
stray=$(docker run --rm --entrypoint find "$IMAGE" /app/node_modules /app/docker/migrator/node_modules \
  -regextype posix-extended -type f -regex '.*/query_compiler_[a-z]+_bg\.[a-z0-9]+\.(js|mjs|wasm|wasm-base64\.m?js)' \
  ! -regex ".*/query_compiler_[a-z]+_bg\.$provider\..*" -print)
[ -z "$stray" ] || fail "node_modules holds the query compilers of other providers:"$'\n'"$stray"

# sharp ships its addon and libvips once per libc, and the image keeps the builds of its own libc only.
other_libc=linuxmusl
if docker run --rm --entrypoint sh "$IMAGE" -c 'ls /lib/ld-musl-* > /dev/null 2>&1'; then other_libc=linux; fi
log "checking that both node_modules trees hold no sharp build for the other libc ($other_libc)"
stray=$(docker run --rm --entrypoint find "$IMAGE" /app/node_modules /app/docker/migrator/node_modules \
  -regextype posix-extended -type d -regex ".*/@img/sharp-(libvips-)?$other_libc-[^/]+" -prune -print)
[ -z "$stray" ] || fail "node_modules holds sharp builds for another libc:"$'\n'"$stray"
# The support upload route imports sharp for image dimensions and thumbnails, and fails without it.
log 'checking that the sharp build the image keeps loads'
docker run --rm --entrypoint node "$IMAGE" -e "require('sharp')" > /dev/null || fail 'sharp does not load in the image'

# A 1x1 PNG that the image optimizer, were it on, would serve optimized. The proxy guards every file of public/, and the
# optimizer fetches a local image without the caller's cookies, so the probe sits where statically imported images do,
# under /_next/static/media.
base64 -d > "$WORK/probe.png" \
  <<< 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
chmod 0644 "$WORK/probe.png"

log 'creating a throwaway CA and the PostgreSQL server certificate'
mkdir -p "$WORK/ca" "$WORK/tls" "$WORK/initdb"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=LibreDB smoke CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$WORK/ca.key" -out "$WORK/ca/ca.crt" 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$POSTGRES" \
  -keyout "$WORK/tls/server.key" -out "$WORK/server.csr" 2> /dev/null
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
  "$POSTGRES" > "$WORK/server.ext"
openssl x509 -req -days 1 -in "$WORK/server.csr" -CA "$WORK/ca/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
  -extfile "$WORK/server.ext" -out "$WORK/tls/server.crt" 2> /dev/null
# The image runs as uid 1001, so the CA must be readable by everyone; the server key is copied in by root below.
chmod 0755 "$WORK" "$WORK/ca" "$WORK/tls" "$WORK/initdb"
chmod 0644 "$WORK/ca/ca.crt" "$WORK/tls/server.crt" "$WORK/tls/server.key"

# Runs after the bootstrap: every remote client must use TLS, so a step that connected without it would fail.
cat > "$WORK/initdb/02-tls-only.sh" <<'TLS_ONLY'
#!/bin/sh
set -eu
sed -i 's/^host /hostssl /' "$PGDATA/pg_hba.conf"
TLS_ONLY
chmod 0755 "$WORK/initdb/02-tls-only.sh"

docker rm -f "$SERVE" "$KEYCLOAK" "$POSTGRES" > /dev/null 2>&1 || true
docker network rm "$NETWORK" > /dev/null 2>&1 || true
docker network create "$NETWORK" > /dev/null

log "starting $POSTGRES_IMAGE and $KEYCLOAK_IMAGE"
# PostgreSQL refuses a key that is readable by others or not owned by its user, so the entry point copies it first.
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  -v "$ROOT/docker/postgres/bootstrap.psql:/libredb/bootstrap.psql:ro" \
  -v "$ROOT/docker/postgres/init/01-bootstrap.sh:/docker-entrypoint-initdb.d/01-bootstrap.sh:ro" \
  -v "$WORK/initdb/02-tls-only.sh:/docker-entrypoint-initdb.d/02-tls-only.sh:ro" \
  -v "$WORK/tls:/libredb/tls-source:ro" \
  --entrypoint sh "$POSTGRES_IMAGE" -c '
    install -d -o postgres -g postgres -m 0700 /libredb/tls &&
    install -o postgres -g postgres -m 0600 /libredb/tls-source/server.crt /libredb/tls-source/server.key /libredb/tls/ &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/libredb/tls/server.crt -c ssl_key_file=/libredb/tls/server.key' > /dev/null
docker run -d --name "$KEYCLOAK" --network "$NETWORK" \
  -e KC_HOSTNAME="http://$KEYCLOAK:8080" -e KC_HEALTH_ENABLED=true \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "$ROOT/tests/fixtures/keycloak/libredb-test-realm.json:/opt/keycloak/data/import/libredb-realm.json:ro" \
  "$KEYCLOAK_IMAGE" start-dev --import-realm > /dev/null

# TCP on 127.0.0.1 is only up after the init scripts have finished.
wait_for 'PostgreSQL is ready' "$POSTGRES" docker exec "$POSTGRES" pg_isready -h 127.0.0.1 -U postgres -d libredb

# The fixture passwords of docker/postgres/init/01-bootstrap.sh; the seal key is the published development key of
# scripts/dev/gen-seal-keypair.mjs. None of these values is valid outside tests.
MIGRATE_ENV=(
  -e "MIGRATE_DATABASE_URL=postgresql://libredb_owner:libredb_owner_dev@$POSTGRES:5432/libredb?schema=platform&sslcert=$CA_DIR/ca.crt&sslaccept=strict"
)
RUNTIME_ENV=(
  -e DEPLOYMENT_MODE=self-hosted
  -e "DATABASE_URL=postgresql://libredb_platform:libredb_platform_dev@$POSTGRES:5432/libredb?schema=platform&sslmode=verify-full&sslrootcert=$CA_DIR/ca.crt"
  -e "NODE_EXTRA_CA_CERTS=$CA_DIR/ca.crt"
)
SERVE_ENV=(
  -e AUTH_SECRET=docker-smoke-auth-secret-not-for-production-use
  -e AUTH_URL=http://localhost:3000
  -e "AUTH_KEYCLOAK_ISSUER=http://$KEYCLOAK:8080/realms/libredb"
  -e AUTH_KEYCLOAK_ID=libredb-platform
  -e AUTH_KEYCLOAK_SECRET=libredb-platform-test-secret
  -e STUDIO_PUBLIC_URL=http://localhost:3200
  -e BRIDGE_SEAL_PUBLIC_KEY=WULR-dfqAG93r5aNvR9xqMm_AkNbdbimJmSD1YzobyY
)

for attempt in 1 2; do
  log "migrate, run $attempt"
  run_image "${MIGRATE_ENV[@]}" "${RUNTIME_ENV[@]}" -e PLATFORM_ORGANIZATION_NAME='LibreDB Smoke' "$IMAGE" migrate \
    || fail "migrate run $attempt exited $?"
done

wait_for 'Keycloak is ready' "$KEYCLOAK" keycloak_ready

log 'serve'
docker run -d --name "$SERVE" --network "$NETWORK" -v "$WORK/ca:$CA_DIR:ro" \
  -v "$WORK/probe.png:/app/.next/static/media/docker-smoke-probe.png:ro" \
  "${RUNTIME_ENV[@]}" "${SERVE_ENV[@]}" "$IMAGE" > /dev/null
wait_for 'serve is live' "$SERVE" probe /api/health/live
wait_for 'serve is ready' "$SERVE" probe /api/health/ready

log 'GET /_next/image answers 404, because the image optimizer is off'
docker exec "$SERVE" node -e "
  const path = '/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fdocker-smoke-probe.png&w=64&q=75'
  fetch('http://127.0.0.1:' + process.env.PORT + path, { headers: { accept: 'image/webp' } }).then(response => {
    const image = (response.headers.get('content-type') ?? '').startsWith('image/')
    process.exit(response.status === 404 && !image ? 0 : 1)
  }, () => process.exit(1))
" || fail '/_next/image served the probe, so the image optimizer is on'

log 'maintain'
run_image "${RUNTIME_ENV[@]}" "${SERVE_ENV[@]}" "$IMAGE" maintain || fail "maintain exited $?"

log 'migrate-status'
run_image "${MIGRATE_ENV[@]}" "$IMAGE" migrate-status || fail "migrate-status exited $?"

# A migration that stops halfway stays recorded as started and never finished, and every later `migrate` stops with
# P3009 until `migrate-resolve` repairs the history (docs/deploy/platform-runtime.md). The objects of the migration
# marked failed here exist, so after --rolled-back marks that attempt, --applied records it without running it again.
migration=$(docker exec "$POSTGRES" psql -U postgres -d libredb -qAt -c "
  UPDATE platform._prisma_migrations SET finished_at = NULL
  WHERE migration_name = (SELECT max(migration_name) FROM platform._prisma_migrations)
  RETURNING migration_name") || fail "marking the newest migration failed exited $?"
[ -n "$migration" ] || fail 'platform._prisma_migrations holds no migration to mark failed'
log "migrate, after $migration was marked failed"
status=0
output=$(run_image "${MIGRATE_ENV[@]}" "${RUNTIME_ENV[@]}" -e PLATFORM_ORGANIZATION_NAME='LibreDB Smoke' \
  "$IMAGE" migrate 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! grep -qw P3009 <<< "$output" || ! grep -qF "$migration" <<< "$output"; then
  fail "migrate over the failed migration $migration exited $status without P3009:"$'\n'"$output"
fi

log 'migrate-resolve --rolled-back'
run_image "${MIGRATE_ENV[@]}" "$IMAGE" migrate-resolve --rolled-back "$migration" \
  || fail "migrate-resolve --rolled-back exited $?"
log 'migrate-resolve --applied'
run_image "${MIGRATE_ENV[@]}" "$IMAGE" migrate-resolve --applied "$migration" \
  || fail "migrate-resolve --applied exited $?"
log 'migrate-status, after the repair'
run_image "${MIGRATE_ENV[@]}" "$IMAGE" migrate-status || fail "migrate-status after the repair exited $?"

log 'an unknown argument'
status=0
docker run --rm "$IMAGE" docker-smoke-unknown-argument 2> /dev/null || status=$?
[ "$status" -eq 64 ] || fail "an unknown argument exited $status, not 64"

failed=0
log 'every step passed'
