#!/usr/bin/env bash
# The resilience test of the Helm chart, on the kind cluster run-e2e.sh set up:
#
#   LIBREDB_E2E_LICENSE=kind.license charts/libredb-platform/tests/e2e/run-resilience.sh
#
# It installs the chart, and the browser suite restore.k8s.ts (phase seed) has the first admin connect a target
# PostgreSQL and grant a Keycloak user, who reads the table in Studio. Then it kills, without a grace period, the
# PostgreSQL pod, then Platform, Studio and Keycloak at once, and finally restarts the kind node itself, the cluster's
# power cut. After each it waits, with no other action, until the three endpoints answer again, reports how long that
# took, and checks that the connections, the grants and the Keycloak users are what they were. The browser suite
# (phase verify) then signs the first admin in with the seed's password and TOTP device and has the user read the table
# through the credential sealed in the seed. LIBREDB_E2E_KEEP=1 keeps the installation.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
node=${LIBREDB_E2E_KIND_NODE:-libredb-helm-control-plane}
target_namespace=libredb-resilience-target
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

status() { curl -s --max-time 5 --resolve "$1:443:127.0.0.1" --cacert "$work/ca.crt" -o /dev/null -w '%{http_code}' "https://$1$2" || true; }
answering() {
  [ "$(status platform.libredb.test /api/health/ready)" = 200 ] && [ "$(status studio.libredb.test /api/ready)" = 200 ] \
    && [ "$(status auth.libredb.test /realms/libredb/.well-known/openid-configuration)" = 200 ]
}
# Waits, doing nothing else, until the three endpoints answer 200, and prints how long that took since $1.
recovered() {
  local since=$1
  for _ in $(seq 1 240); do
    if answering; then echo "every endpoint answers again $(( $(date +%s) - since )) s after it"; return; fi
    sleep 5
  done
  fail "the endpoints did not answer within 20 minutes"
}

psql_super() {
  kubectl -n "$namespace" exec -i libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -q -h 127.0.0.1 -U postgres -d "$1"' sh "$1"
}
# What a crash must not lose: the connections with their envelopes, the grants, and the realm's users.
fingerprint() {
  {
    echo "SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM (SELECT id, \"readSecret\", \"writeSecret\" FROM platform.database_connections) t;
          SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM platform.connection_grants t;" | psql_super libredb
    echo "SELECT md5(coalesce(string_agg(username, '|' ORDER BY username), '')) FROM user_entity;" | psql_super keycloak
  } | tr '\n' ' '
}

browser() {
  (cd "$installer" && LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_TARGET_NAMESPACE="$target_namespace" \
    LIBREDB_E2E_RESTORE_PHASE="$1" LIBREDB_E2E_RESTORE_STATE="$work/state.json" LIBREDB_E2E_ACCOUNT_FILE="$work/first-admin.json" \
    bunx playwright test --config e2e/kubernetes/playwright.config.ts restore.k8s.ts)
}

step "a fresh installation in namespace $namespace, the target database in $target_namespace"
helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
kubectl delete namespace "$namespace" "$target_namespace" --ignore-not-found --wait=true >/dev/null
for ns in "$namespace" "$target_namespace"; do
  kubectl create namespace "$ns" >/dev/null
  kubectl label namespace "$ns" pod-security.kubernetes.io/enforce=restricted >/dev/null
done
helm install libredb "$chart" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
  --wait --wait-for-jobs --timeout 10m >/dev/null
kubectl -n "$namespace" get secret libredb-tls-platform -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$work/ca.crt"

step "seed: a connection, a grant and a read in Studio"
browser seed
before=$(fingerprint)
echo "fingerprint $before"

step "PostgreSQL killed without a grace period"
started=$(date +%s)
kubectl -n "$namespace" delete pod libredb-postgres-0 --grace-period=0 --force >/dev/null 2>&1
recovered "$started"
[ "$(fingerprint)" = "$before" ] || fail "the data changed: $(fingerprint)"

step "Platform, Studio and Keycloak killed at once"
started=$(date +%s)
kubectl -n "$namespace" delete pod -l 'app.kubernetes.io/component in (platform,keycloak)' --grace-period=0 --force >/dev/null 2>&1
kubectl -n "$namespace" delete pod -l app.kubernetes.io/name=studio --grace-period=0 --force >/dev/null 2>&1
recovered "$started"
[ "$(fingerprint)" = "$before" ] || fail "the data changed: $(fingerprint)"

step "the node $node restarted, the cluster's power cut"
started=$(date +%s)
docker restart "$node" >/dev/null
for _ in $(seq 1 120); do kubectl get nodes >/dev/null 2>&1 && break; sleep 5; done
kubectl wait --for=condition=Ready "node/$node" --timeout=600s >/dev/null
recovered "$started"
[ "$(fingerprint)" = "$before" ] || fail "the data changed: $(fingerprint)"
restarts=$(kubectl -n "$namespace" get pods -o 'jsonpath={range .items[*]}{.metadata.name}={range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}')
printf 'container restarts after the power cut:\n%s\n' "$restarts"

step "verify: the first admin signs in, and the user reads the table through the credential of the seed"
browser verify

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" "$target_namespace" --wait=true >/dev/null
fi
printf '\nPASS\n'
