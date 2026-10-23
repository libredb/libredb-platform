#!/usr/bin/env bash
# The backup and restore test of the Helm chart, on the kind cluster run-e2e.sh set up, with the steps of "Back up and
# restore" in docs/deploy/install-kubernetes.md:
#
#   LIBREDB_E2E_LICENSE=kind.license charts/libredb-platform/tests/e2e/run-restore.sh
#
# It installs the chart, and the browser suite restore.k8s.ts (phase seed) has the first admin connect a target
# PostgreSQL in a namespace of its own and grant a Keycloak user, who reads the table in Studio. Then it takes the
# backup set of the guide (the three Secrets and a pg_dump of each database), deletes the installation's namespace,
# volumes included, restores the set into a new namespace of the same name and checks the seal keys, the CA, the
# license and Studio's seal canary; the browser suite (phase verify) then signs the first admin in with the seed's
# password and TOTP device and has the user read the table again, through the credential sealed before the backup.
# LIBREDB_E2E_KEEP=1 keeps the restored installation and the target database.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
target_namespace=libredb-restore-target
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
backup="$work/backup"

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
secret_hash() { kubectl -n "$namespace" get secret "$1" -o "jsonpath={.data.$2}" | sha256sum | cut -d' ' -f1; }

install_chart() {
  helm upgrade --install libredb "$chart" -n "$namespace" -f "$here/values-kind.yaml" \
    --set-file platform.license.value="$license" --wait --wait-for-jobs --timeout 10m
}

restricted_namespace() {
  kubectl create namespace "$1" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$1" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
}

browser() {
  (cd "$installer" && LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_TARGET_NAMESPACE="$target_namespace" \
    LIBREDB_E2E_RESTORE_PHASE="$1" LIBREDB_E2E_RESTORE_STATE="$work/state.json" LIBREDB_E2E_ACCOUNT_FILE="$work/first-admin.json" \
    bunx playwright test --config e2e/kubernetes/playwright.config.ts restore.k8s.ts)
}

databases=(libredb keycloak)

step "a fresh installation in namespace $namespace, the target database in $target_namespace"
helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
kubectl delete namespace "$namespace" "$target_namespace" --ignore-not-found --wait=true >/dev/null
restricted_namespace "$namespace"
restricted_namespace "$target_namespace"
install_chart >/dev/null

step "seed: a connection, a grant and a read in Studio"
browser seed

step "the backup set of the guide"
mkdir -m 0700 "$backup"
kubectl -n "$namespace" get secret libredb-secrets libredb-tls libredb-installer-state -o yaml > "$backup/secrets.yaml"
for db in "${databases[@]}"; do
  kubectl -n "$namespace" exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U postgres -Fc -d "$1"' sh "$db" > "$backup/$db.dump"
done
seal=$(secret_hash libredb-secrets 'seal-keys\.json')
ca=$(secret_hash libredb-tls 'ca\.crt')
ls -l "$backup" | tail -n +2

step "the disaster: namespace $namespace deleted, its volumes with it"
helm -n "$namespace" uninstall libredb --wait >/dev/null
kubectl delete namespace "$namespace" --wait=true >/dev/null
volumes() { kubectl get pv -o 'jsonpath={range .items[*]}{.spec.claimRef.namespace}{"\n"}{end}' | grep -cx "$namespace" || true; }
for _ in $(seq 1 60); do [ "$(volumes)" = "0" ] && break; sleep 2; done
[ "$(volumes)" = "0" ] || fail "a volume of $namespace survived"
echo "namespace and volumes gone"

step "restore: the Secrets, a new install, then each database while the apps are stopped"
restricted_namespace "$namespace"
kubectl -n "$namespace" create -f "$backup/secrets.yaml" >/dev/null
install_chart >/dev/null
kubectl -n "$namespace" scale deployment libredb-platform libredb-studio keycloak --replicas=0 >/dev/null
kubectl -n "$namespace" wait --for=delete pod -l 'app.kubernetes.io/component in (platform,keycloak)' --timeout=180s >/dev/null
kubectl -n "$namespace" wait --for=delete pod -l app.kubernetes.io/name=studio --timeout=180s >/dev/null
for db in "${databases[@]}"; do
  kubectl -n "$namespace" exec -i libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U postgres --clean --if-exists --exit-on-error -d "$1"' sh "$db" \
    < "$backup/$db.dump"
done
kubectl -n "$namespace" scale deployment libredb-platform libredb-studio keycloak --replicas=1 >/dev/null
for deploy in libredb-platform libredb-studio keycloak; do
  kubectl -n "$namespace" rollout status "deploy/$deploy" --timeout=300s >/dev/null
done

step "the restored installation"
[ "$(secret_hash libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the restore changed the seal keys"
[ "$(secret_hash libredb-tls 'ca\.crt')" = "$ca" ] || fail "the restore changed the internal CA"
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
for _ in $(seq 1 30); do
  heartbeat=$(kubectl -n "$namespace" exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -h 127.0.0.1 -U postgres -d libredb -c "SELECT canary FROM bridge.studio_instances_v1"')
  grep -q '"ok"' <<<"$heartbeat" && break
  sleep 5
done
grep -q '"ok"' <<<"$heartbeat" || fail "Studio's seal canary is not ok: $heartbeat"
echo "seal keys and CA of the backup, license active, seal canary ok"

step "verify: the first admin of the backup signs in, and the user reads the table through the restored credential"
browser verify

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" "$target_namespace" --wait=true >/dev/null
fi
printf '\nPASS\n'
