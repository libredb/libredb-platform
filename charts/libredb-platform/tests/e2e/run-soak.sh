#!/usr/bin/env bash
# The soak test of the Helm chart, on the kind cluster run-e2e.sh set up: one installation left running for hours.
#
#   LIBREDB_E2E_LICENSE=kind.license LIBREDB_E2E_SOAK_HOURS=8 LIBREDB_E2E_SOAK_OUT=/dir \
#     charts/libredb-platform/tests/e2e/run-soak.sh
#
# After the seed of restore.k8s.ts it checks the three endpoints every 30 seconds, records every 5 minutes each
# container's memory and CPU from the node's CRI, the restart counts, the databases' sizes and the size of the pods'
# logs, and every 30 minutes has the browser suite (phase verify) sign the first admin in and the user read the table.
# The CSV files and summary.txt land in LIBREDB_E2E_SOAK_OUT. It fails when a verify run fails or a container restarts;
# availability, latency, memory and growth go to the summary. LIBREDB_E2E_KEEP=1 keeps the installation.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
hours=${LIBREDB_E2E_SOAK_HOURS:-8}
# LIBREDB_E2E_SOAK_MINUTES, for a short trial run, wins over the hours.
seconds=$(( ${LIBREDB_E2E_SOAK_MINUTES:-$(( hours * 60 ))} * 60 ))
out=${LIBREDB_E2E_SOAK_OUT:?a directory for the measurements}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
node=${LIBREDB_E2E_KIND_NODE:-libredb-helm-control-plane}
target_namespace=libredb-soak-target
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

step() { printf '\n=== %s\n' "$*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

browser() {
  (cd "$installer" && LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_TARGET_NAMESPACE="$target_namespace" \
    LIBREDB_E2E_RESTORE_PHASE="$1" LIBREDB_E2E_RESTORE_STATE="$work/state.json" LIBREDB_E2E_ACCOUNT_FILE="$work/first-admin.json" \
    bunx playwright test --config e2e/kubernetes/playwright.config.ts restore.k8s.ts)
}
psql_super() {
  kubectl -n "$namespace" exec -i libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -A -t -q -h 127.0.0.1 -U postgres -d libredb'
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
browser seed

echo "time,endpoint,status,seconds" > "$out/endpoints.csv"
echo "time,pod,container,memory_bytes,cpu_nanocores" > "$out/memory.csv"
echo "time,restarts,libredb_db_bytes,keycloak_db_bytes,pod_log_bytes" > "$out/growth.csv"
echo "time,verify" > "$out/verify.csv"

probe() {
  local host=$1 path=$2 result
  result=$(curl -s --max-time 20 --resolve "$host:443:127.0.0.1" --cacert "$work/ca.crt" -o /dev/null -w '%{http_code},%{time_total}' "https://$host$path" || echo "000,20")
  echo "$(now),$host,$result" >> "$out/endpoints.csv"
}
sample() {
  local pods
  pods=$(docker exec "$node" crictl pods --namespace "$namespace" -q | tr '\n' ' ')
  for pod in $pods; do
    docker exec "$node" crictl stats -p "$pod" -o json 2>/dev/null | python3 -I -c '
import json, sys
stats = json.load(sys.stdin).get("stats", [])
for s in stats:
    attrs = s["attributes"]
    pod = attrs["labels"].get("io.kubernetes.pod.name", "")
    mem = s.get("memory", {}).get("workingSetBytes", {}).get("value", 0)
    # crictl matches the namespace as a pattern, and a finished job container reports nothing.
    if attrs["labels"].get("io.kubernetes.pod.namespace") != sys.argv[2] or mem == 0:
        continue
    cpu = s.get("cpu", {}).get("usageNanoCores", {}).get("value", 0)
    name = attrs["metadata"]["name"]
    print(f"{sys.argv[1]},{pod},{name},{mem},{cpu}")
' "$(now)" "$namespace" >> "$out/memory.csv"
  done
  local restarts sizes logs
  restarts=$(kubectl -n "$namespace" get pods -o 'jsonpath={range .items[*]}{range .status.containerStatuses[*]}{.restartCount}{"\n"}{end}{end}' | awk '{s+=$1} END {print s+0}')
  sizes=$(echo "SELECT pg_database_size('libredb') || ',' || pg_database_size('keycloak')" | psql_super)
  logs=$(docker exec "$node" sh -c "du -sb /var/log/pods/${namespace}_* 2>/dev/null | awk '{s+=\$1} END {print s+0}'")
  echo "$(now),$restarts,$sizes,$logs" >> "$out/growth.csv"
}

step "soak for $(( seconds / 60 )) minutes"
end=$(( $(date +%s) + seconds ))
next_sample=0
# Every 30 minutes, or twice in a run shorter than an hour.
verify_every=$(( seconds < 3600 ? seconds / 2 : 1800 ))
next_verify=$(( $(date +%s) + verify_every ))
failures=0
while [ "$(date +%s)" -lt "$end" ]; do
  probe platform.libredb.test /api/health/ready
  probe studio.libredb.test /api/ready
  probe auth.libredb.test /realms/libredb/.well-known/openid-configuration
  if [ "$(date +%s)" -ge "$next_sample" ]; then
    sample || echo "$(now) sample failed"
    next_sample=$(( $(date +%s) + 300 ))
  fi
  if [ "$(date +%s)" -ge "$next_verify" ]; then
    if browser verify > "$work/verify.log" 2>&1; then echo "$(now),pass" >> "$out/verify.csv"; else
      echo "$(now),fail" >> "$out/verify.csv"; failures=$((failures + 1)); cp "$work/verify.log" "$out/verify-fail-$(date +%s).log"
    fi
    next_verify=$(( $(date +%s) + verify_every ))
  fi
  sleep 30
done
sample

step "summary"
python3 -I - "$out" > "$out/summary.txt" <<'EOF'
import csv, sys, statistics, collections
out = sys.argv[1]
rows = list(csv.DictReader(open(f"{out}/endpoints.csv")))
print(f"endpoint checks: {len(rows)}")
for host in sorted({r["endpoint"] for r in rows}):
    mine = [r for r in rows if r["endpoint"] == host]
    ok = [r for r in mine if r["status"] == "200"]
    times = sorted(float(r["seconds"]) for r in ok)
    p99 = times[int(len(times) * 0.99) - 1] if times else 0
    print(f"  {host}: {len(ok)}/{len(mine)} answered 200 ({100 * len(ok) / max(len(mine), 1):.3f}%), median {statistics.median(times) if times else 0:.3f} s, p99 {p99:.3f} s, max {max(times) if times else 0:.3f} s")
mem = list(csv.DictReader(open(f"{out}/memory.csv")))
by = collections.defaultdict(list)
for r in mem:
    by[r["container"]].append(int(r["memory_bytes"]))
print("memory, first hour average -> last hour average (MiB):")
for name, values in sorted(by.items()):
    first, last = values[:12], values[-12:]
    a, b = statistics.mean(first) / 2**20, statistics.mean(last) / 2**20
    print(f"  {name}: {a:.0f} -> {b:.0f} ({100 * (b - a) / a if a else 0:+.1f}%), peak {max(values) / 2**20:.0f}")
growth = list(csv.DictReader(open(f"{out}/growth.csv")))
if growth:
    f, l = growth[0], growth[-1]
    print(f"restarts: {f['restarts']} -> {l['restarts']}")
    for key in ("libredb_db_bytes", "keycloak_db_bytes", "pod_log_bytes"):
        print(f"{key}: {int(f[key]) / 2**20:.1f} MiB -> {int(l[key]) / 2**20:.1f} MiB")
verify = list(csv.DictReader(open(f"{out}/verify.csv")))
print(f"browser verify runs: {sum(r['verify'] == 'pass' for r in verify)} passed, {sum(r['verify'] == 'fail' for r in verify)} failed")
EOF
cat "$out/summary.txt"
restarts=$(tail -1 "$out/growth.csv" | cut -d, -f2)

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" "$target_namespace" --wait=true >/dev/null
fi
[ "$failures" -eq 0 ] || { echo "FAIL: $failures browser verify runs failed"; exit 1; }
[ "$restarts" = "0" ] || { echo "FAIL: containers restarted $restarts times"; exit 1; }
printf '\nPASS\n'
