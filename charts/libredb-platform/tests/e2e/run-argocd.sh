#!/usr/bin/env bash
# The Argo CD test of the chart, on the kind cluster run-e2e.sh set up (Traefik, the *.libredb.test DNS), with no Helm
# release of the chart in the cluster, since it uses the same hosts:
#
#   LIBREDB_E2E_LICENSE=kind.license LIBREDB_E2E_CHART_REPO=/dir/with/index.yaml/and/tgz \
#     charts/libredb-platform/tests/e2e/run-argocd.sh
#
# It installs Argo CD with label resource tracking, the method under which a tool would prune the objects the jobs
# write if they carried the release's instance label, serves the packaged chart from a Helm repository in the cluster,
# and syncs an Application with automated prune and self-heal into a namespace that enforces the restricted Pod
# Security Standard. It checks that the app turns Synced and Healthy, the endpoints answer, the jobs' Secrets survive
# the prune of every sync, a new sync runs the jobs again without touching the seal keys, and a changed value reaches
# the running Platform through the PostSync restart job.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
license=${LIBREDB_E2E_LICENSE:?a license for platform.libredb.test}
repo=${LIBREDB_E2E_CHART_REPO:?a directory with the packaged chart and its index.yaml}
argocd_version=${LIBREDB_E2E_ARGOCD_VERSION:-v3.5.5}
namespace=libredb-argo
# The chart's own version, at the indent of an index entry, not a dependency's.
version=$(awk '/^    version:/{print $2; exit}' "$repo/index.yaml" | tr -d '"')

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
app() { kubectl -n argocd get application libredb -o "jsonpath=$1"; }
ready() { curl -s --resolve "$1:443:127.0.0.1" -k -o /dev/null -w '%{http_code}' "https://$1$2"; }
hash_of() { kubectl -n "$namespace" get secret "$1" -o "jsonpath={.data.$2}" | sha256sum | cut -d' ' -f1; }
wait_synced() {
  for _ in $(seq 1 180); do
    if [ "$(app '{.status.sync.status}')" = "Synced" ] && [ "$(app '{.status.health.status}')" = "Healthy" ] \
      && [ "$(app '{.status.operationState.phase}')" = "Succeeded" ]; then return; fi
    sleep 5
  done
  fail "the app is $(app '{.status.sync.status}')/$(app '{.status.health.status}'), operation $(app '{.status.operationState.phase}'): $(app '{.status.operationState.message}')"
}

step "Argo CD $argocd_version with label resource tracking"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# LIBREDB_E2E_ARGOCD_MANIFEST names a downloaded install.yaml, for a cluster whose nodes reach no registry or GitHub.
kubectl apply -n argocd --server-side --force-conflicts \
  -f "${LIBREDB_E2E_ARGOCD_MANIFEST:-https://raw.githubusercontent.com/argoproj/argo-cd/$argocd_version/manifests/install.yaml}" >/dev/null
kubectl -n argocd patch configmap argocd-cm --type merge -p '{"data":{"application.resourceTrackingMethod":"label"}}' >/dev/null
kubectl -n argocd rollout restart statefulset/argocd-application-controller >/dev/null
for deploy in argocd-repo-server argocd-server; do kubectl -n argocd rollout status "deploy/$deploy" --timeout=300s >/dev/null; done
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=300s >/dev/null

step "a Helm repository in the cluster serving libredb-platform $version"
kubectl create namespace chartrepo --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n chartrepo create configmap charts --from-file="$repo" --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f - >/dev/null
kubectl -n chartrepo apply -f - >/dev/null <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: chartrepo}
spec:
  selector: {matchLabels: {app: chartrepo}}
  template:
    metadata: {labels: {app: chartrepo}}
    spec:
      containers:
        - name: httpd
          image: busybox:1.37
          command: ["httpd", "-f", "-p", "8080", "-h", "/srv"]
          volumeMounts: [{name: charts, mountPath: /srv}]
      volumes: [{name: charts, configMap: {name: charts}}]
---
apiVersion: v1
kind: Service
metadata: {name: chartrepo}
spec: {selector: {app: chartrepo}, ports: [{port: 8080}]}
EOF
kubectl -n chartrepo rollout restart deploy/chartrepo >/dev/null
kubectl -n chartrepo rollout status deploy/chartrepo --timeout=120s >/dev/null

step "the Application: automated sync with prune and self-heal into $namespace"
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
kubectl -n "$namespace" create secret generic libredb-license --from-file=license="$license" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
application() {
  cat <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: libredb, namespace: argocd}
spec:
  project: default
  source:
    repoURL: http://chartrepo.chartrepo.svc:8080
    chart: libredb-platform
    targetRevision: "$version"
    helm:
      releaseName: libredb
      valuesObject:
        hosts: {platform: platform.libredb.test, studio: studio.libredb.test, auth: auth.libredb.test}
        platform:
          organizationName: Acme Argo
          license: {existingSecret: libredb-license}
          $1
        studio:
          config: {oidcIssuer: "https://auth.libredb.test/realms/libredb"}
          ingress:
            hosts: [{host: studio.libredb.test, paths: [{path: /, pathType: Prefix}]}]
            tls: [{secretName: libredb-tls-studio, hosts: [studio.libredb.test]}]
  destination: {server: https://kubernetes.default.svc, namespace: $namespace}
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    retry: {limit: 5, backoff: {duration: 10s, factor: 2, maxDuration: 3m}}
EOF
}
application "" | kubectl apply -f - >/dev/null
started=$(date +%s)
wait_synced
echo "Synced and Healthy in $(( $(date +%s) - started )) s"

step "endpoints, license and the jobs' Secrets"
[ "$(ready platform.libredb.test /api/health/ready)" = "200" ] || fail "Platform is not ready"
[ "$(ready studio.libredb.test /api/ready)" = "200" ] || fail "Studio is not ready"
[ "$(ready auth.libredb.test /realms/libredb/.well-known/openid-configuration)" = "200" ] || fail "Keycloak's realm does not answer"
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
seal=$(hash_of libredb-secrets 'seal-keys\.json')
annotations=$(kubectl -n "$namespace" get secret libredb-secrets -o 'jsonpath={.metadata.annotations}')
grep -q 'Prune=false' <<<"$annotations" || fail "libredb-secrets lacks Argo CD's Prune=false: $annotations"
labels=$(kubectl -n "$namespace" get secret libredb-secrets -o 'jsonpath={.metadata.labels}')
grep -q 'app.kubernetes.io/instance' <<<"$labels" && fail "libredb-secrets carries the tracking label: $labels"
echo "Platform, Studio and Keycloak answer, license active, the jobs' Secrets carry no tracking label"

step "a new sync with prune runs the jobs again and keeps every Secret of the jobs"
migrate=$(kubectl -n "$namespace" get jobs -l app.kubernetes.io/component=platform-migrate -o 'jsonpath={.items[0].metadata.uid}')
kubectl -n argocd patch application libredb --type merge \
  -p "{\"operation\":{\"initiatedBy\":{\"username\":\"e2e\"},\"sync\":{\"revision\":\"$version\",\"prune\":true}}}" >/dev/null
sleep 5
wait_synced
again=$(kubectl -n "$namespace" get jobs -l app.kubernetes.io/component=platform-migrate -o 'jsonpath={.items[0].metadata.uid}')
[ -n "$again" ] && [ "$again" != "$migrate" ] || fail "the sync did not run the migrate job again"
for secret in libredb-secrets libredb-tls libredb-installer-state libredb-platform-env libredb-studio-env; do
  kubectl -n "$namespace" get secret "$secret" >/dev/null || fail "the sync pruned Secret $secret"
done
[ "$(hash_of libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the sync changed the seal keys"
echo "the migrate job ran again, every Secret of the jobs is there, the seal keys unchanged"

step "a changed value reaches the running Platform through the PostSync restart job"
application "queryLogRetentionDays: 30" | kubectl apply -f - >/dev/null
for _ in $(seq 1 60); do
  [ "$(kubectl -n "$namespace" get secret libredb-platform-env -o 'jsonpath={.data.QUERY_LOG_RETENTION_DAYS}' | base64 -d)" = "30" ] && break
  sleep 5
done
wait_synced
kubectl -n "$namespace" rollout status deploy/libredb-platform --timeout=300s >/dev/null
running=$(kubectl -n "$namespace" exec deploy/libredb-platform -- printenv QUERY_LOG_RETENTION_DAYS)
[ "$running" = "30" ] || fail "the running Platform has QUERY_LOG_RETENTION_DAYS=$running"
[ "$(hash_of libredb-secrets 'seal-keys\.json')" = "$seal" ] || fail "the change changed the seal keys"
echo "the running Platform has QUERY_LOG_RETENTION_DAYS=30, the seal keys unchanged"

printf '\nPASS\n'
