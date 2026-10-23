#!/usr/bin/env bash
# The end-to-end test of the Helm chart on a local kind cluster, which it creates when missing:
#
#   LIBREDB_E2E_LICENSE=kind.license charts/libredb-platform/tests/e2e/run-e2e.sh
#
# The license must name the host platform.libredb.test. The test installs the chart with a managed PostgreSQL and
# Keycloak, checks the endpoints and the edge's path rules against the internal CA, the license, Studio's heartbeat
# and its seal canary, runs the browser suite (installer/e2e/kubernetes), upgrades with a changed value and checks that
# the seal keys and the CA stay, and finally uninstalls and installs again and checks the same. It uses only the kind
# cluster it names; it never touches other containers or volumes of the host's Docker.
# Needs kind, kubectl, helm, curl and bun on PATH. LIBREDB_E2E_KEEP=1 keeps the installation running at the end.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
cluster=${LIBREDB_E2E_CLUSTER:-libredb-helm}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

install_chart() {
  helm upgrade --install libredb "$chart" -n "$namespace" --create-namespace -f "$here/values-kind.yaml" \
    --set-file platform.license.value="$license" "$@" --wait --wait-for-jobs --timeout 10m
}

secret_hash() { kubectl -n "$namespace" get secret "$1" -o "jsonpath={.data.$2}" | sha256sum | cut -d' ' -f1; }

if [ "${LIBREDB_E2E_EXISTING_CLUSTER:-0}" = "1" ]; then
  # A cluster this script set up before, reached through KUBECONFIG, such as from a container on kind's network.
  step "the cluster of KUBECONFIG, set up earlier"
else
  step "kind cluster $cluster"
  if ! kind get clusters | grep -qx "$cluster"; then
    sed "s/^name: .*/name: $cluster/" "$here/kind-config.yaml" > "$work/kind-config.yaml"
    kind create cluster --config "$work/kind-config.yaml" --wait 180s
  fi
  kubectl config use-context "kind-$cluster" >/dev/null

  step "Traefik and the in-cluster DNS of *.libredb.test"
  helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  helm repo update traefik >/dev/null
  helm upgrade --install traefik traefik/traefik --version 41.7.1 -n traefik --create-namespace \
    -f "$here/traefik-values.yaml" --wait --timeout 5m >/dev/null
  "$here/coredns-rewrite.sh"
fi

step "chart dependencies"
if [ ! -f "$chart/charts/libredb-studio-0.1.100.tgz" ]; then
  # helm dependency build takes Chart.lock's Studio chart only from a repository Helm knows.
  helm repo add libredb-studio https://libredb.org/libredb-studio/ >/dev/null 2>&1 || true
  helm dependency build "$chart"
fi

step "install into a namespace that enforces the restricted Pod Security Standard"
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
started=$(date +%s)
install_chart >/dev/null
echo "installed in $(( $(date +%s) - started )) s"
errors=$(kubectl -n "$namespace" get pods --no-headers | awk '$3 == "Error" || $3 == "CrashLoopBackOff"' | wc -l)
[ "$errors" -eq 0 ] || fail "$errors pods failed during the install"

step "endpoints, the edge's path rules and TLS against the internal CA"
kubectl -n "$namespace" get secret libredb-tls-platform -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$work/ca.crt"
resolve=(--resolve platform.libredb.test:443:127.0.0.1 --resolve studio.libredb.test:443:127.0.0.1 --resolve auth.libredb.test:443:127.0.0.1)
expect_status() {
  local status
  status=$(curl -s "${resolve[@]}" --cacert "$work/ca.crt" --path-as-is -o /dev/null -w '%{http_code}' "$2")
  [ "$status" = "$1" ] || fail "$2 answered $status, not $1"
  printf '%s %s\n' "$status" "$2"
}
expect_status 200 https://platform.libredb.test/api/health/ready
expect_status 200 https://studio.libredb.test/api/ready
expect_status 200 https://auth.libredb.test/realms/libredb/.well-known/openid-configuration
expect_status 404 https://auth.libredb.test/admin/
expect_status 404 https://auth.libredb.test/realms/master/
expect_status 400 "https://auth.libredb.test/realms/libredb/..;/master/"

step "network policies: a pod of another namespace reaches Platform but not Keycloak's Admin API or PostgreSQL"
probe() {
  kubectl -n default run "np-probe-$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.37 -- \
    sh -c "nc -z -w 3 $1 $2 && echo open || echo closed" 2>/dev/null | tail -1
}
[ "$(probe "libredb-platform.$namespace.svc" 3000)" = "open" ] || fail "the probe pod cannot reach Platform at all"
[ "$(probe "keycloak.$namespace.svc" 8080)" = "closed" ] || fail "a pod outside the release reaches Keycloak's Admin API"
[ "$(probe "libredb-postgres.$namespace.svc" 5432)" = "closed" ] || fail "a pod outside the release reaches PostgreSQL"
echo "Keycloak's Admin API and PostgreSQL refuse a pod outside the release"

step "license and Studio's heartbeat"
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
# Platform publishes the canary when it starts, and Studio reports it with its next heartbeat, every 30 seconds.
for _ in $(seq 1 30); do
  heartbeat=$(kubectl -n "$namespace" exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -h 127.0.0.1 -U postgres -d libredb -c "SELECT canary FROM bridge.studio_instances_v1"')
  grep -q '"ok"' <<<"$heartbeat" && break
  sleep 5
done
grep -q '"ok"' <<<"$heartbeat" || fail "Studio's seal canary is not ok: $heartbeat"
echo "license active; seal canary $heartbeat"

step "browser suite"
account="$work/first-admin.json"
first_admin_file="${LIBREDB_E2E_ACCOUNT_FILE:-$account}"
# The license's id, from its payload, the third dot-separated field in base64url.
license_id=$(cut -d. -f3 "$license" | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)
(cd "$installer" && LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_ACCOUNT_FILE="$first_admin_file" LIBREDB_E2E_LICENSE_ID="$license_id" \
  bunx playwright test --config e2e/kubernetes/playwright.config.ts)

step "upgrade with a changed value keeps the seal keys and the CA"
seal=$(secret_hash libredb-secrets 'seal-keys\.json')
ca=$(secret_hash libredb-tls 'ca\.crt')
install_chart --set platform.queryLogRetentionDays=30 >/dev/null
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the upgrade changed the seal keys"
[ "$(secret_hash libredb-tls 'ca\.crt')" = "$ca" ] || fail "the upgrade changed the internal CA"
retention=$(kubectl -n "$namespace" get secret libredb-platform-env -o 'jsonpath={.data.QUERY_LOG_RETENTION_DAYS}' | base64 -d)
[ "$retention" = "30" ] || fail "QUERY_LOG_RETENTION_DAYS is $retention after the upgrade"
# The bootstrap hook restarted Platform, whose environment changed, so the running server has the new value.
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=180s >/dev/null
running=$(kubectl -n "$namespace" exec deploy/libredb-platform -- printenv QUERY_LOG_RETENTION_DAYS)
[ "$running" = "30" ] || fail "the running Platform has QUERY_LOG_RETENTION_DAYS=$running after the upgrade"
expect_status 200 https://platform.libredb.test/api/health/ready
echo "seal keys and CA kept, QUERY_LOG_RETENTION_DAYS=30 in the Secret and the running server"

step "a rollback within the release runs the bootstrap with the earlier values and restarts Platform"
helm -n "$namespace" rollback libredb --wait --timeout 10m >/dev/null
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=180s >/dev/null
running=$(kubectl -n "$namespace" exec deploy/libredb-platform -- printenv QUERY_LOG_RETENTION_DAYS)
[ "$running" = "90" ] || fail "the running Platform has QUERY_LOG_RETENTION_DAYS=$running after the rollback"
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the rollback changed the seal keys"
expect_status 200 https://platform.libredb.test/api/health/ready
echo "rolled back to QUERY_LOG_RETENTION_DAYS=90, seal keys kept"

step "uninstall keeps the generated Secrets and the volumes; a new install reuses them"
helm -n "$namespace" uninstall libredb --wait >/dev/null
for name in libredb-secrets libredb-tls libredb-installer-state; do
  kubectl -n "$namespace" get secret "$name" >/dev/null || fail "uninstall removed Secret $name"
done
kubectl -n "$namespace" get pvc data-libredb-postgres-0 >/dev/null || fail "uninstall removed the database volume"
install_chart >/dev/null
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the reinstall changed the seal keys"
[ "$(secret_hash libredb-tls 'ca\.crt')" = "$ca" ] || fail "the reinstall changed the internal CA"
kubectl -n "$namespace" logs -l app.kubernetes.io/component=keycloak-configure --tail=20 | grep -c "realm already converged" >/dev/null \
  || fail "the reinstall's keycloak job did not find the realm converged"
expect_status 200 https://platform.libredb.test/api/health/ready
expect_status 200 https://studio.libredb.test/api/ready
echo "reinstall reused the seal keys, the CA, the database and the realm"

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" --wait=true >/dev/null
fi
printf '\nPASS\n'
