#!/usr/bin/env bash
# The install without network access of docs/deploy/install-kubernetes.md, on the kind cluster run-e2e.sh set up:
#
#   LIBREDB_E2E_LICENSE=kind.license LIBREDB_E2E_MIRROR=libredb-mirror:5000 LIBREDB_E2E_MIRROR_PUSH=localhost:5055 \
#     charts/libredb-platform/tests/e2e/run-offline.sh
#
# LIBREDB_E2E_MIRROR is a registry the cluster's nodes pull from, LIBREDB_E2E_MIRROR_PUSH the same registry as this
# host reaches it. On the connected side the test packages the chart with its dependency and copies the release's
# images into the mirror by digest; on the site side Helm runs with no repository configured and every proxy pointing
# at a closed port, installs the archive with each image repository set to the mirror, and the test checks that every
# container ran an image of the mirror, the endpoints, the license and Studio's seal canary.
# LIBREDB_E2E_KEEP=1 keeps the installation.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
mirror=${LIBREDB_E2E_MIRROR:?the mirror registry as the nodes reach it}
push=${LIBREDB_E2E_MIRROR_PUSH:?the mirror registry as this host reaches it}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "connected side: the chart archive with its dependency"
helm package --dependency-update "$chart" -d "$work" >/dev/null
archive=$(ls "$work"/libredb-platform-*.tgz)
tar -tzf "$archive" | grep -cx 'libredb-platform/charts/libredb-studio/Chart.yaml' >/dev/null || fail "the archive lacks the Studio chart"
echo "$(basename "$archive") holds the Studio chart"

step "connected side: the release's images into the mirror, by digest"
images=$(helm template libredb "$archive" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
  | grep -oE 'image: "?[^" ]+' | awk '{print $2}' | tr -d '"' | sort -u)
for image in $images; do
  # registry/repository:tag@digest, copied as repository:tag with its index, so the digest stays.
  name=${image#*/}
  name=${name%@*}
  docker buildx imagetools create -t "$push/$name" "$image" >/dev/null 2>&1
  echo "$name"
done

# LIBREDB_E2E_KIND_NODE: a kind node whose copies of these images go first, so its pods pull them from the mirror.
if [ -n "${LIBREDB_E2E_KIND_NODE:-}" ]; then
  step "the node $LIBREDB_E2E_KIND_NODE forgets the release's images"
  for image in $images; do
    for ref in "$image" "$mirror/${image#*/}"; do
      docker exec "$LIBREDB_E2E_KIND_NODE" crictl rmi "$ref" >/dev/null 2>&1 || true
      docker exec "$LIBREDB_E2E_KIND_NODE" crictl inspecti "$ref" >/dev/null 2>&1 && fail "the node still holds $ref"
    done
  done
  echo "none of them left on the node"
fi

step "site side: Helm with no repository and no way out"
export HELM_REPOSITORY_CONFIG="$work/repositories.yaml" HELM_REPOSITORY_CACHE="$work/cache" HELM_REGISTRY_CONFIG="$work/registry.json"
export HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
# helm repo list fails when no repository is configured, which is what this checks.
repos=$(helm repo list 2>&1 || true)
grep -q "no repositories" <<<"$repos" || fail "Helm has a repository configured: $repos"
helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
kubectl delete namespace "$namespace" --ignore-not-found --wait=true >/dev/null
kubectl create namespace "$namespace" >/dev/null
kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted >/dev/null
mirrored=(
  --set "platform.image.repository=$mirror/libredb/libredb-platform"
  --set "postgresql.managed.image.repository=$mirror/library/postgres"
  --set "keycloak.managed.image.repository=$mirror/keycloak/keycloak"
  --set "keycloak.managed.edge.image.repository=$mirror/library/caddy"
  --set "studio.image.repository=$mirror/libredb/libredb-studio"
)
rendered=$(helm template libredb "$archive" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" "${mirrored[@]}" \
  | grep -oE 'image: "?[^" ]+' | awk '{print $2}' | tr -d '"' | sort -u)
outside=$(grep -v "^$mirror/" <<<"$rendered" || true)
[ -z "$outside" ] || fail "images outside the mirror: $outside"
started=$(date +%s)
helm install libredb "$archive" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
  "${mirrored[@]}" --wait --wait-for-jobs --timeout 10m >/dev/null
echo "installed from the archive in $(( $(date +%s) - started )) s, every image from $mirror"
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy

step "every container ran an image the nodes pulled from the mirror"
ids=$(kubectl -n "$namespace" get pods -o 'jsonpath={range .items[*]}{range .status.initContainerStatuses[*]}{.imageID}{"\n"}{end}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}' | sort -u)
outside=$(grep -v "^$mirror/" <<<"$ids" || true)
[ -z "$outside" ] || fail "containers ran images from elsewhere: $outside"
sed 's/^/  /' <<<"$ids"

step "endpoints, license and Studio's heartbeat"
kubectl -n "$namespace" get secret libredb-tls-platform -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$work/ca.crt"
for url in https://platform.libredb.test/api/health/ready https://studio.libredb.test/api/ready \
  https://auth.libredb.test/realms/libredb/.well-known/openid-configuration; do
  host=${url#https://}
  status=$(curl -s --resolve "${host%%/*}:443:127.0.0.1" --cacert "$work/ca.crt" -o /dev/null -w '%{http_code}' "$url")
  [ "$status" = "200" ] || fail "$url answered $status"
  echo "200 $url"
done
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
for _ in $(seq 1 30); do
  heartbeat=$(kubectl -n "$namespace" exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -h 127.0.0.1 -U postgres -d libredb -c "SELECT canary FROM bridge.studio_instances_v1"')
  grep -q '"ok"' <<<"$heartbeat" && break
  sleep 5
done
grep -q '"ok"' <<<"$heartbeat" || fail "Studio's seal canary is not ok: $heartbeat"
echo "license active; seal canary $heartbeat"

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" --wait=true >/dev/null
fi
printf '\nPASS\n'
