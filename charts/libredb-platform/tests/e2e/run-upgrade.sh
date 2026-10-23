#!/usr/bin/env bash
# The release upgrade test, on the installation run-e2e.sh left running (LIBREDB_E2E_KEEP=1), with this chart as the
# installed release and a chart of a later release:
#
#   LIBREDB_E2E_LICENSE=kind.license LIBREDB_E2E_NEXT_CHART=/path/to/next/charts/libredb-platform \
#     charts/libredb-platform/tests/e2e/run-upgrade.sh
#
# First an upgrade to the next release that fails after its hooks (Studio's image does not exist) under --atomic
# must roll back to this release, which the installation still counts as its own. Then it upgrades to the next release and checks that the
# migrate job and Platform run the next image, the installation records the next release, the seal keys and the CA
# stay, and Platform and Studio keep working; then that going back, by an upgrade with this chart or by helm rollback,
# is refused at once by the bootstrap job and leaves the next release running, and that the documented recovery from
# the refused rollback's pending record lets the next upgrade through.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
next=${LIBREDB_E2E_NEXT_CHART:?the chart directory of the next release}
license=${LIBREDB_E2E_LICENSE:?a license for platform.libredb.test}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
release() { kubectl -n "$namespace" get secret libredb-installer-state -o 'jsonpath={.data.release}' | base64 -d; }
hash_of() { kubectl -n "$namespace" get secret "$1" -o "jsonpath={.data.$2}" | sha256sum | cut -d' ' -f1; }
image() { kubectl -n "$namespace" get deploy libredb-platform -o 'jsonpath={.spec.template.spec.containers[0].image}'; }
ready() { curl -s --resolve "$1:443:127.0.0.1" -k -o /dev/null -w '%{http_code}' "https://$1$2"; }
deploy() {
  helm upgrade libredb "$1" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
    --wait --wait-for-jobs --timeout 10m
}

next_version=$(awk '/^appVersion:/{gsub(/"/,"",$2); print $2}' "$next/Chart.yaml")
this_version=$(awk '/^appVersion:/{gsub(/"/,"",$2); print $2}' "$chart/Chart.yaml")
seal=$(hash_of libredb-secrets 'seal-keys\.json')
ca=$(hash_of libredb-tls 'ca\.crt')
[ "$(release)" = "$this_version" ] || fail "the installation runs $(release), not $this_version"

step "a failed upgrade under --atomic rolls back to $this_version"
if helm upgrade libredb "$next" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
  --set studio.image.tag=does-not-exist --atomic --wait --wait-for-jobs --timeout 3m > /tmp/atomic.log 2>&1; then
  fail "the upgrade to a missing image succeeded"
fi
grep -q "rolled back\|rollback" /tmp/atomic.log || fail "--atomic did not roll back: $(tail -2 /tmp/atomic.log)"
status=$(helm -n "$namespace" status libredb -o json | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>console.log(JSON.parse(t).info.status))')
[ "$status" = "deployed" ] || fail "the release is $status after the atomic rollback"
case "$(image)" in *":$this_version"*) ;; *) fail "Platform runs $(image) after the atomic rollback" ;; esac
[ "$(release)" = "$this_version" ] || fail "the installation records $(release) after the atomic rollback"
for _ in $(seq 1 60); do [ "$(ready platform.libredb.test /api/health/ready)" = "200" ] && break; sleep 3; done
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready after the atomic rollback"
echo "rolled back to $this_version, release deployed, Platform ready"

step "upgrade $this_version -> $next_version"
deploy "$next" >/dev/null
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=300s >/dev/null
case "$(image)" in *":$next_version"*) ;; *) fail "Platform runs $(image) after the upgrade" ;; esac
migrate=$(kubectl -n "$namespace" get jobs -l app.kubernetes.io/component=platform-migrate -o 'jsonpath={.items[*].spec.template.spec.containers[0].image}')
case "$migrate" in *":$next_version"*) ;; *) fail "the migrate job ran $migrate" ;; esac
[ "$(release)" = "$next_version" ] || fail "the installation records $(release) after the upgrade"
[ "$(hash_of libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the upgrade changed the seal keys"
[ "$(hash_of libredb-tls 'ca\.crt')" = "$ca" ] || fail "the upgrade changed the internal CA"
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready on $next_version"
[ "$(ready studio.libredb.test /api/ready)" = "200" ] || fail "Studio is not ready on $next_version"
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform $next_version did not log License active"
echo "Platform and its migrate job run $next_version, the installation records it, seal keys and CA kept"

step "an upgrade back to $this_version is refused"
if deploy "$chart" > /tmp/downgrade.log 2>&1; then fail "the downgrade to $this_version succeeded"; fi
kubectl -n "$namespace" logs job/libredb-bootstrap 2>/dev/null | grep -c "a downgrade is not supported" >/dev/null \
  || grep -q "downgrade is not supported\|pre-upgrade hooks failed" /tmp/downgrade.log || fail "the downgrade failed for another reason: $(tail -3 /tmp/downgrade.log)"
case "$(image)" in *":$next_version"*) ;; *) fail "Platform runs $(image) after the refused downgrade" ;; esac
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready after the refused downgrade"
echo "refused: $(kubectl -n "$namespace" logs job/libredb-bootstrap 2>/dev/null | grep -o 'this chart runs LibreDB [^:]*' | head -1)"

step "helm rollback to the $this_version revision is refused"
target=$(helm -n "$namespace" history libredb -o json | node -e '
  let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    const deployed = JSON.parse(text).filter((r) => r.app_version === process.argv[1] && r.status !== "failed");
    console.log(deployed.length === 0 ? "" : deployed[deployed.length - 1].revision);
  });' "$this_version")
[ -n "$target" ] && [ "$target" != "null" ] || fail "no deployed revision of $this_version to roll back to"
if helm -n "$namespace" rollback libredb "$target" --wait --timeout 10m > /tmp/rollback.log 2>&1; then fail "the rollback to $this_version succeeded"; fi
grep -q "PodFailurePolicy\|pre-rollback hooks failed" /tmp/rollback.log || fail "the rollback failed for another reason: $(tail -3 /tmp/rollback.log)"
kubectl -n "$namespace" logs job/libredb-bootstrap | grep -c "a downgrade is not supported" >/dev/null || fail "the rollback's bootstrap failed for another reason"
case "$(image)" in *":$next_version"*) ;; *) fail "Platform runs $(image) after the refused rollback" ;; esac
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready after the refused rollback"
echo "refused at once; Platform still runs $next_version"

step "the documented recovery from the refused rollback's pending record"
pending=$(helm -n "$namespace" history libredb -o json | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const p=JSON.parse(t).filter(r=>r.status==="pending-rollback");console.log(p.length?p[p.length-1].revision:"")})')
[ -n "$pending" ] || fail "Helm left no pending-rollback record, so the recovery step of the docs is stale"
kubectl -n "$namespace" delete secret "sh.helm.release.v1.libredb.v$pending" >/dev/null
deploy "$next" >/dev/null || fail "the upgrade after the recovery failed"
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready after the recovery"
echo "removed the pending record v$pending, and the next upgrade went through"

printf '\nPASS\n'
