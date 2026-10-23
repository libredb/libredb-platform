#!/usr/bin/env bash
# Makes every *.libredb.test name resolve, inside the kind cluster, to the Traefik Service, the way a real site's DNS
# points the three hosts at its ingress: Platform and Studio call Keycloak's public issuer URL from their pods.
set -euo pipefail
corefile=$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')
if grep -q 'libredb\\.test' <<<"$corefile"; then
  echo "CoreDNS already rewrites *.libredb.test"
  exit 0
fi
rewritten=$(sed 's|^\(    ready\)$|\1\n    rewrite name regex (.*)\\.libredb\\.test traefik.traefik.svc.cluster.local answer auto|' <<<"$corefile")
kubectl -n kube-system create configmap coredns --from-literal=Corefile="$rewritten" --dry-run=client -o yaml | kubectl -n kube-system apply -f - >/dev/null
kubectl -n kube-system rollout restart deployment coredns >/dev/null
kubectl -n kube-system rollout status deployment coredns --timeout=120s
