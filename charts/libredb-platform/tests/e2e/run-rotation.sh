#!/usr/bin/env bash
# The rotation test of the Helm chart, on the kind cluster run-e2e.sh set up: a fresh installation, then the browser
# suite rotation.k8s.ts, which walks the seal key rotation and the secret rotations of "Rotate secrets and the seal
# key" in docs/deploy/install-kubernetes.md, one helm upgrade per step:
#
#   LIBREDB_E2E_LICENSE=kind.license charts/libredb-platform/tests/e2e/run-rotation.sh
#
# LIBREDB_E2E_KEEP=1 keeps the installation.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
installer=$(cd "$chart/../../installer" && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform.libredb.test}
namespace=${LIBREDB_E2E_NAMESPACE:-libredb}
target_namespace=libredb-rotation-target
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }

step "a fresh installation in namespace $namespace, the target database in $target_namespace"
helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
kubectl delete namespace "$namespace" "$target_namespace" --ignore-not-found --wait=true >/dev/null
for ns in "$namespace" "$target_namespace"; do
  kubectl create namespace "$ns" >/dev/null
  kubectl label namespace "$ns" pod-security.kubernetes.io/enforce=restricted >/dev/null
done
helm install libredb "$chart" -n "$namespace" -f "$here/values-kind.yaml" --set-file platform.license.value="$license" \
  --wait --wait-for-jobs --timeout 10m >/dev/null

step "the rotations, one helm upgrade per step"
(cd "$installer" && LIBREDB_E2E_ROTATION=1 LIBREDB_E2E_NAMESPACE="$namespace" LIBREDB_E2E_TARGET_NAMESPACE="$target_namespace" \
  LIBREDB_E2E_CHART="$chart" LIBREDB_E2E_VALUES="$here/values-kind.yaml" LIBREDB_E2E_LICENSE="$license" \
  LIBREDB_E2E_ACCOUNT_FILE="$work/first-admin.json" \
  bunx playwright test --config e2e/kubernetes/playwright.config.ts rotation.k8s.ts)

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" "$target_namespace" --wait=true >/dev/null
fi
printf '\nPASS\n'
