#!/usr/bin/env bash
# The end-to-end test of the Helm chart on OpenShift, in the one namespace of the current `oc login`, such as a Red
# Hat Developer Sandbox's:
#
#   LIBREDB_E2E_LICENSE=os.license LIBREDB_E2E_DOMAIN=apps.example.openshiftapps.com \
#     charts/libredb-platform/tests/e2e/run-openshift.sh
#
# The hosts are ldb-platform-<namespace>.<domain>, ldb-studio-<namespace>.<domain> and ldb-auth-<namespace>.<domain>,
# under the apps domain the router serves, and the license must name the first. OpenShift turns each Ingress into a
# Route that terminates TLS with the Ingress's Secret, so the endpoints answer with leaves of the internal CA. The test
# needs no cluster scope: it checks that the restricted-v2 SCC admits every pod with a uid from the namespace's range,
# the endpoints, the edge's path rules, the license and Studio's seal canary, runs the browser suite, upgrades, rolls
# back, uninstalls and installs again, as run-e2e.sh does on kind. It removes everything the chart left in the
# namespace before it starts and when it ends (LIBREDB_E2E_KEEP=1 keeps the last installation), and nothing else.
# Needs oc, kubectl, helm, curl and bun on PATH.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for ldb-platform-<namespace>.<domain>}
domain=${LIBREDB_E2E_DOMAIN:?set LIBREDB_E2E_DOMAIN to the apps domain of the router}
namespace=$(oc project -q)
platform=ldb-platform-$namespace.$domain
studio=ldb-studio-$namespace.$domain
auth=ldb-auth-$namespace.$domain
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

sed -e "s/ldb-platform\.apps\.example\.com/$platform/g" -e "s/ldb-studio\.apps\.example\.com/$studio/g" \
  -e "s/ldb-auth\.apps\.example\.com/$auth/g" "$here/values-openshift.yaml" > "$work/values.yaml"

install_chart() {
  helm upgrade --install libredb "$chart" -n "$namespace" -f "$work/values.yaml" \
    --set-file platform.license.value="$license" "$@" --wait --wait-for-jobs --timeout 15m
}

secret_hash() { kubectl -n "$namespace" get secret "$1" -o "jsonpath={.data.$2}" | sha256sum | cut -d' ' -f1; }

# What the chart leaves on purpose after helm uninstall: the jobs' Secrets and ConfigMaps and the volumes.
remove_installation() {
  helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete pod/e2e-target service/e2e-target --ignore-not-found >/dev/null
  kubectl -n "$namespace" delete secret,configmap -l app.kubernetes.io/managed-by=libredb-bootstrap --ignore-not-found >/dev/null
  kubectl -n "$namespace" delete pvc -l app.kubernetes.io/instance=libredb --ignore-not-found --wait=true >/dev/null
}

step "a clean namespace $namespace"
remove_installation

step "install with OpenShift's restricted-v2 SCC"
started=$(date +%s)
install_chart >/dev/null
echo "installed in $(( $(date +%s) - started )) s"
errors=$(kubectl -n "$namespace" get pods --no-headers | awk '$3 == "Error" || $3 == "CrashLoopBackOff"' | wc -l)
[ "$errors" -eq 0 ] || fail "$errors pods failed during the install"

step "every pod runs under restricted-v2 with a uid from the namespace's range"
range=$(oc get namespace "$namespace" -o 'jsonpath={.metadata.annotations.openshift\.io/sa\.scc\.uid-range}')
first=${range%/*}
size=${range#*/}
pods=$(kubectl -n "$namespace" get pods -l app.kubernetes.io/instance=libredb --field-selector=status.phase=Running -o name)
[ -n "$pods" ] || fail "no running pod of the release"
for pod in $pods; do
  scc=$(kubectl -n "$namespace" get "$pod" -o 'jsonpath={.metadata.annotations.openshift\.io/scc}')
  [ "$scc" = "restricted-v2" ] || fail "$pod runs under SCC $scc"
  # The SCC writes the uid it assigned into each container's security context.
  uid=$(kubectl -n "$namespace" get "$pod" -o 'jsonpath={.spec.containers[0].securityContext.runAsUser}')
  [ "$uid" -ge "$first" ] && [ "$uid" -lt $(( first + size )) ] || fail "$pod runs as uid $uid, outside $range"
  printf '%s restricted-v2 uid %s\n' "$pod" "$uid"
done

step "the Routes OpenShift made of the Ingresses"
for host in "$platform" "$studio" "$auth"; do
  termination=$(kubectl -n "$namespace" get routes -o "jsonpath={.items[?(@.spec.host=='$host')].spec.tls.termination}")
  [ "$termination" = "edge" ] || fail "no edge Route for $host"
done
echo "edge Routes for the three hosts"

step "endpoints, the edge's path rules and TLS against the internal CA"
kubectl -n "$namespace" get secret libredb-tls-platform -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$work/ca.crt"
expect_status() {
  local status
  status=$(curl -s --cacert "$work/ca.crt" --path-as-is -o /dev/null -w '%{http_code}' "$2")
  [ "$status" = "$1" ] || fail "$2 answered $status, not $1"
  printf '%s %s\n' "$status" "$2"
}
expect_status 200 "https://$platform/api/health/ready"
expect_status 200 "https://$studio/api/ready"
expect_status 200 "https://$auth/realms/libredb/.well-known/openid-configuration"
expect_status 404 "https://$auth/admin/"
expect_status 404 "https://$auth/realms/master/"
expect_status 400 "https://$auth/realms/libredb/..;/master/"

step "license and Studio's heartbeat"
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
for _ in $(seq 1 30); do
  heartbeat=$(kubectl -n "$namespace" exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -h 127.0.0.1 -U postgres -d libredb -c "SELECT canary FROM bridge.studio_instances_v1"')
  grep -q '"ok"' <<<"$heartbeat" && break
  sleep 5
done
grep -q '"ok"' <<<"$heartbeat" || fail "Studio's seal canary is not ok: $heartbeat"
echo "license active; seal canary $heartbeat"

step "browser suite"
license_id=$(cut -d. -f3 "$license" | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)
(cd "$installer" && LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_OPENSHIFT=1 \
  LIBREDB_E2E_PLATFORM_URL="https://$platform" LIBREDB_E2E_STUDIO_URL="https://$studio" \
  LIBREDB_E2E_LICENSE_ID="$license_id" LIBREDB_E2E_ACCOUNT_FILE="${LIBREDB_E2E_ACCOUNT_FILE:-$work/first-admin.json}" \
  bunx playwright test --config e2e/kubernetes/playwright.config.ts)

step "upgrade with a changed value keeps the seal keys and the CA"
seal=$(secret_hash libredb-secrets 'seal-keys\.json')
ca=$(secret_hash libredb-tls 'ca\.crt')
install_chart --set platform.queryLogRetentionDays=30 >/dev/null
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the upgrade changed the seal keys"
[ "$(secret_hash libredb-tls 'ca\.crt')" = "$ca" ] || fail "the upgrade changed the internal CA"
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=180s >/dev/null
running=$(kubectl -n "$namespace" exec deploy/libredb-platform -- printenv QUERY_LOG_RETENTION_DAYS)
[ "$running" = "30" ] || fail "the running Platform has QUERY_LOG_RETENTION_DAYS=$running after the upgrade"
expect_status 200 "https://$platform/api/health/ready"
echo "seal keys and CA kept, QUERY_LOG_RETENTION_DAYS=30 in the running server"

step "a rollback within the release restores the earlier values"
helm -n "$namespace" rollback libredb --wait --timeout 15m >/dev/null
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=180s >/dev/null
running=$(kubectl -n "$namespace" exec deploy/libredb-platform -- printenv QUERY_LOG_RETENTION_DAYS)
[ "$running" = "90" ] || fail "the running Platform has QUERY_LOG_RETENTION_DAYS=$running after the rollback"
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the rollback changed the seal keys"
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
expect_status 200 "https://$platform/api/health/ready"
expect_status 200 "https://$studio/api/ready"
echo "reinstall reused the seal keys, the CA, the database and the realm"

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  remove_installation
fi
printf '\nPASS\n'
