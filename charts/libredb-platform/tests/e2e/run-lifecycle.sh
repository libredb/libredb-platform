#!/usr/bin/env bash
# The lifecycle test of a Helm install, on the installation run-e2e.sh left running (LIBREDB_E2E_KEEP=1):
#
#   LIBREDB_E2E_LICENSE=active.license LIBREDB_E2E_LICENSE_EXPIRING=expiring.license \
#   LIBREDB_E2E_LICENSE_EXPIRED=expired.license charts/libredb-platform/tests/e2e/run-lifecycle.sh
#
# Certificate renewal: the clock of a kind node cannot move, so the test puts the installation where it would stand
# after two years: it replaces the PostgreSQL leaf and Platform's ingress leaf with leaves of the same internal CA that
# expire in 10 days, and restarts PostgreSQL so it serves its short leaf. An upgrade with unchanged values must then
# re-issue both, PostgreSQL must serve its new leaf after the restart job, the ingress its new one, and the apps keep
# working over verify-full. License lifecycle: an upgrade with a license that expires within 30 days, one that has
# expired and then the active one again must each reach the running Platform, which logs the state.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
active=${LIBREDB_E2E_LICENSE:?the active license for platform.libredb.test}
expiring=${LIBREDB_E2E_LICENSE_EXPIRING:?a license for platform.libredb.test that expires within 30 days}
expired=${LIBREDB_E2E_LICENSE_EXPIRED:?a license for platform.libredb.test past its grace period}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
# Days until a certificate's notAfter; a read that failed gives none, so a wait never takes it for an answer.
days_left() {
  [ -n "$1" ] || { echo -1; return; }
  echo $(( ( $(date -d "$1" +%s) - $(date +%s) ) / 86400 ))
}

upgrade() {
  local license=$1
  shift
  helm upgrade libredb "$chart" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" "$@" \
    --wait --wait-for-jobs --timeout 10m >/dev/null
}

# The leaf PostgreSQL serves, read after the SSLRequest of the protocol from Platform's pod, which the network
# policies let in.
pg_not_after() {
  kubectl -n "$namespace" exec deploy/libredb-platform -- node -e '
    const net = require("net"), tls = require("tls");
    const socket = net.connect(5432, "libredb-postgres", () => { const b = Buffer.alloc(8); b.writeInt32BE(8); b.writeInt32BE(80877103, 4); socket.write(b); });
    socket.once("data", (reply) => {
      if (String(reply) !== "S") { console.error("no TLS"); process.exit(1); }
      const secure = tls.connect({ socket, servername: "libredb-postgres", rejectUnauthorized: false }, () => { console.log(secure.getPeerCertificate().valid_to); process.exit(0); });
    });'
}

ingress_not_after() {
  openssl s_client -connect 127.0.0.1:443 -servername "$1" </dev/null 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2
}

platform_license_line() {
  kubectl -n "$namespace" logs deploy/libredb-platform | grep '"message":"License' | tail -1
}

wait_platform() {
  kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=300s >/dev/null
  for _ in $(seq 1 60); do
    [ "$(curl -s --resolve platform.libredb.test:443:127.0.0.1 -k -o /dev/null -w '%{http_code}' https://platform.libredb.test/api/health/ready)" = "200" ] && return
    sleep 3
  done
  fail "Platform did not turn ready"
}

step "leaves of the internal CA that expire in 10 days, as after two years"
kubectl -n "$namespace" get secret libredb-tls -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$work/ca.crt"
kubectl -n "$namespace" get secret libredb-tls -o 'jsonpath={.data.ca\.key}' | base64 -d > "$work/ca.key"
short_leaf() {
  local name=$1 sans=$2
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$name" -keyout "$work/$name.key" -out "$work/$name.csr" 2>/dev/null
  openssl x509 -req -in "$work/$name.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 10 \
    -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$sans") -out "$work/$name.crt" 2>/dev/null
}
b64() { base64 -w0 < "$1"; }
short_leaf postgres "DNS:libredb-postgres,DNS:libredb-postgres.$namespace,DNS:libredb-postgres.$namespace.svc,DNS:libredb-postgres.$namespace.svc.cluster.local"
short_leaf platform "DNS:platform.libredb.test"
kubectl -n "$namespace" patch secret libredb-tls --type merge -p "{\"data\":{\"postgres.crt\":\"$(b64 "$work/postgres.crt")\",\"postgres.key\":\"$(b64 "$work/postgres.key")\",\"platform.crt\":\"$(b64 "$work/platform.crt")\",\"platform.key\":\"$(b64 "$work/platform.key")\"}}" >/dev/null
kubectl -n "$namespace" patch secret libredb-postgres-tls --type merge -p "{\"data\":{\"server.crt\":\"$(b64 "$work/postgres.crt")\",\"server.key\":\"$(b64 "$work/postgres.key")\"}}" >/dev/null
kubectl -n "$namespace" patch secret libredb-tls-platform --type merge -p "{\"data\":{\"tls.crt\":\"$(b64 "$work/platform.crt")\",\"tls.key\":\"$(b64 "$work/platform.key")\"}}" >/dev/null
kubectl -n "$namespace" rollout restart statefulset/libredb-postgres >/dev/null
kubectl -n "$namespace" rollout status statefulset/libredb-postgres --timeout=300s >/dev/null
for _ in $(seq 1 30); do
  left=$(days_left "$(pg_not_after 2>/dev/null || true)") && [ "$left" -ge 0 ] && [ "$left" -le 10 ] && break
  sleep 5
done
{ [ "$left" -ge 0 ] && [ "$left" -le 10 ]; } || fail "PostgreSQL does not serve the short leaf: $left days left"
for _ in $(seq 1 30); do
  ingress=$(days_left "$(ingress_not_after platform.libredb.test || true)") && [ "$ingress" -ge 0 ] && [ "$ingress" -le 10 ] && break
  sleep 3
done
{ [ "$ingress" -ge 0 ] && [ "$ingress" -le 10 ]; } || fail "the ingress does not serve the short leaf: $ingress days left"
echo "PostgreSQL serves a leaf with $left days left, the ingress one with $ingress"

step "an upgrade with unchanged values re-issues both leaves and restarts PostgreSQL"
upgrade "$active"
kubectl -n "$namespace" rollout status statefulset/libredb-postgres --timeout=300s >/dev/null
for _ in $(seq 1 60); do
  left=$(days_left "$(pg_not_after 2>/dev/null || true)") && [ "$left" -gt 800 ] && break
  sleep 5
done
[ "$left" -gt 800 ] || fail "PostgreSQL still serves a leaf with $left days left after the upgrade"
for _ in $(seq 1 40); do
  ingress=$(days_left "$(ingress_not_after platform.libredb.test || true)") && [ "$ingress" -gt 800 ] && break
  sleep 3
done
[ "$ingress" -gt 800 ] || fail "the ingress still serves a leaf with $ingress days left"
wait_platform
curl -sf --resolve studio.libredb.test:443:127.0.0.1 --cacert "$work/ca.crt" -o /dev/null https://studio.libredb.test/api/ready || fail "Studio is not ready after PostgreSQL's restart"
echo "PostgreSQL serves a leaf with $left days left, the ingress one with $ingress; Platform and Studio ready"

step "license lifecycle: expiring, expired, active again, each in the running Platform"
for case in "$expiring:expiring:License expiring within 30 days" "$expired:expired:License expired, no seat can be added" "$active:active:License active"; do
  file=${case%%:*}; rest=${case#*:}; state=${rest%%:*}; message=${rest#*:}
  upgrade "$file"
  wait_platform
  line=$(platform_license_line)
  grep -q "\"message\":\"$message\"" <<<"$line" || fail "after the $state license Platform logged: $line"
  grep -q "\"state\":\"$state\"" <<<"$line" || fail "after the $state license Platform logged: $line"
  echo "$state: $(sed 's/.*"licenseId":"\([^"]*\)".*/\1/' <<<"$line")"
done

printf '\nPASS\n'
