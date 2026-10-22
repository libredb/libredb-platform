#!/usr/bin/env bash
# The end-to-end test of the chart against a customer's own PostgreSQL and Keycloak, on the kind cluster that
# run-e2e.sh set up (Traefik, the *.libredb.test DNS):
#
#   LIBREDB_E2E_LICENSE=kind-ext.license charts/libredb-platform/tests/e2e/run-external.sh
#
# The license must name platform-ext.libredb.test. Namespace corp plays the customer: a PostgreSQL server with TLS
# from a CA of its own, at corp-pg.corp.svc.cluster.local, and a Keycloak at https://sso-ext.libredb.test behind
# Traefik with a certificate of the same CA and an admin user in realm master. The chart installs into libredb-ext
# with postgresql.mode external (a DBA runs the script the chart writes) and keycloak.mode external with provisioning
# installer, its own TLS Secrets for the ingress (tls.mode secrets) and the license in a Secret of its own
# (platform.license.existingSecret). The test checks that the install converges, the realm holds the LibreDB objects,
# Platform's client can list users, the license is active, Studio's seal canary is ok, and the ingress serves the
# customer's certificates.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/../.." && pwd)
license=${LIBREDB_E2E_LICENSE:?set LIBREDB_E2E_LICENSE to a license file for platform-ext.libredb.test}
namespace=libredb-ext
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "a fresh start: namespaces corp and $namespace"
helm -n "$namespace" uninstall libredb --wait >/dev/null 2>&1 || true
kubectl delete namespace corp "$namespace" --ignore-not-found --wait=true >/dev/null

step "the customer's CA and certificates"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=Corp test CA" \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
leaf() {
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$2" -keyout "$work/$1.key" -out "$work/$1.csr" 2>/dev/null
  openssl x509 -req -in "$work/$1.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 30 \
    -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$2") -out "$work/$1.crt" 2>/dev/null
}
leaf pg corp-pg.corp.svc.cluster.local
leaf sso sso-ext.libredb.test
leaf platform platform-ext.libredb.test
leaf studio studio-ext.libredb.test

step "the customer's PostgreSQL and Keycloak in namespace corp"
kubectl create namespace corp --dry-run=client -o yaml | kubectl apply -f - >/dev/null
superuser=$(openssl rand -hex 16)
admin_password=$(openssl rand -hex 16)
kubectl -n corp create secret generic corp-pg-tls --from-file=server.crt="$work/pg.crt" --from-file=server.key="$work/pg.key" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n corp create secret tls sso-ext-tls --cert="$work/sso.crt" --key="$work/sso.key" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
postgres_image=$(helm show values "$chart" | awk '/^postgresql:/{p=1} p && /repository:/{r=$2} p && /tag:/{gsub(/"/,"",$2); print r":"$2; exit}')
keycloak_image=$(helm show values "$chart" | awk '/^keycloak:/{p=1} p && /repository: quay/{r=$2} p && r && /tag:/{gsub(/"/,"",$2); print r":"$2; exit}')
kubectl -n corp apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: corp-pg
  labels: {app: corp-pg}
spec:
  securityContext: {fsGroup: 999, runAsUser: 999, runAsNonRoot: true}
  containers:
    - name: postgres
      image: $postgres_image
      args: ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/tls/server.crt", "-c", "ssl_key_file=/tls/server.key"]
      env:
        - {name: POSTGRES_PASSWORD, value: "$superuser"}
      readinessProbe: {exec: {command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"]}, periodSeconds: 2}
      volumeMounts:
        - {name: tls, mountPath: /tls, readOnly: true}
        - {name: run, mountPath: /var/run/postgresql}
        - {name: data, mountPath: /var/lib/postgresql}
  volumes:
    - {name: tls, secret: {secretName: corp-pg-tls, defaultMode: 0640}}
    - {name: run, emptyDir: {}}
    - {name: data, emptyDir: {}}
---
apiVersion: v1
kind: Service
metadata: {name: corp-pg}
spec: {selector: {app: corp-pg}, ports: [{port: 5432}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: corp-sso}
spec:
  selector: {matchLabels: {app: corp-sso}}
  template:
    metadata: {labels: {app: corp-sso}}
    spec:
      containers:
        - name: keycloak
          image: $keycloak_image
          args: ["start-dev"]
          env:
            - {name: KC_HOSTNAME, value: "https://sso-ext.libredb.test"}
            - {name: KC_PROXY_HEADERS, value: xforwarded}
            - {name: KC_HTTP_ENABLED, value: "true"}
            - {name: KC_HEALTH_ENABLED, value: "true"}
            - {name: KC_BOOTSTRAP_ADMIN_USERNAME, value: admin}
            - {name: KC_BOOTSTRAP_ADMIN_PASSWORD, value: "$admin_password"}
          readinessProbe: {httpGet: {path: /health/ready, port: 9000}, periodSeconds: 5}
---
apiVersion: v1
kind: Service
metadata: {name: corp-sso}
spec: {selector: {app: corp-sso}, ports: [{port: 8080}]}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: corp-sso}
spec:
  tls: [{hosts: [sso-ext.libredb.test], secretName: sso-ext-tls}]
  rules:
    - host: sso-ext.libredb.test
      http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: corp-sso, port: {number: 8080}}}}]}
EOF
kubectl -n corp wait --for=condition=Ready pod/corp-pg --timeout=180s >/dev/null
kubectl -n corp rollout status deploy/corp-sso --timeout=300s >/dev/null
resolve=(--resolve sso-ext.libredb.test:443:127.0.0.1 --resolve platform-ext.libredb.test:443:127.0.0.1 --resolve studio-ext.libredb.test:443:127.0.0.1)
# Traefik serves the new Ingress and its certificate a few seconds after it exists.
token=""
for _ in $(seq 1 30); do
  token=$(curl -sf "${resolve[@]}" --cacert "$work/ca.crt" https://sso-ext.libredb.test/realms/master/protocol/openid-connect/token \
    -d grant_type=password -d client_id=admin-cli -d username=admin --data-urlencode "password=$admin_password" \
    | sed 's/.*"access_token":"\([^"]*\)".*/\1/') && [ -n "$token" ] && break
  sleep 2
done
[ -n "$token" ] || fail "the customer's Keycloak gave its admin no token"
# The customer's realm exists before the install: provisioning installer configures objects in it, never the realm.
curl -sf "${resolve[@]}" --cacert "$work/ca.crt" -X POST https://sso-ext.libredb.test/admin/realms \
  -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"realm":"corp","enabled":true}' || true

step "install into $namespace against them"
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
kubectl -n "$namespace" create secret generic corp-keycloak-admin --from-literal=admin-password="$admin_password" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$namespace" create secret generic corp-license --from-file=token="$license" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$namespace" create secret tls corp-platform-tls --cert="$work/platform.crt" --key="$work/platform.key" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$namespace" create secret tls corp-studio-tls --cert="$work/studio.crt" --key="$work/studio.key" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
cat > "$work/values.yaml" <<EOF
hosts: {platform: platform-ext.libredb.test, studio: studio-ext.libredb.test, auth: sso-ext.libredb.test}
platform:
  organizationName: Corp
  license: {existingSecret: corp-license, key: token}
tls:
  mode: secrets
  secrets: {platform: corp-platform-tls, studio: corp-studio-tls}
  caBundle: |
$(sed 's/^/    /' "$work/ca.crt")
postgresql:
  mode: external
  external:
    host: corp-pg.corp.svc.cluster.local
    caBundle: |
$(sed 's/^/      /' "$work/ca.crt")
keycloak:
  mode: external
  realm: corp
  external:
    baseUrl: https://sso-ext.libredb.test
    provisioning: installer
    adminSecret: corp-keycloak-admin
    adminUser: admin
    caBundle: |
$(sed 's/^/      /' "$work/ca.crt")
studio:
  config: {oidcIssuer: "https://sso-ext.libredb.test/realms/corp"}
  ingress:
    hosts: [{host: studio-ext.libredb.test, paths: [{path: /, pathType: Prefix}]}]
    tls: [{secretName: corp-studio-tls, hosts: [studio-ext.libredb.test]}]
EOF
helm upgrade --install libredb "$chart" -n "$namespace" -f "$work/values.yaml" >/dev/null

step "the DBA runs the provisioning script the chart wrote"
for _ in $(seq 1 60); do kubectl -n "$namespace" get secret libredb-postgres-dba-script >/dev/null 2>&1 && break; sleep 2; done
kubectl -n "$namespace" get secret libredb-postgres-dba-script -o 'jsonpath={.data.provision\.sql}' | base64 -d > "$work/provision.sql"
grep -q 'SCRAM-SHA-256\$' "$work/provision.sql" || fail "the DBA script holds no SCRAM verifier"
kubectl -n corp exec -i corp-pg -- sh -c "PGPASSWORD='$superuser' psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres -f -" < "$work/provision.sql" >/dev/null

step "the installation converges"
for _ in $(seq 1 120); do
  ready=$(kubectl -n "$namespace" get deploy libredb-platform libredb-studio -o 'jsonpath={.items[*].status.readyReplicas}')
  [ "$ready" = "1 1" ] && break
  sleep 5
done
[ "$ready" = "1 1" ] || fail "Platform and Studio did not turn ready: $ready"
kubectl -n "$namespace" wait --for=condition=complete job -l app.kubernetes.io/component=keycloak-configure --timeout=300s >/dev/null
kubectl -n "$namespace" wait --for=condition=complete job -l app.kubernetes.io/component=platform-migrate --timeout=300s >/dev/null
kubectl -n "$namespace" logs deploy/libredb-platform | grep -c '"message":"License active"' >/dev/null || fail "Platform did not log License active"
kubectl -n "$namespace" get statefulset libredb-postgres >/dev/null 2>&1 && fail "an external PostgreSQL install runs a managed server"
kubectl -n "$namespace" get deploy keycloak >/dev/null 2>&1 && fail "an external Keycloak install runs a managed Keycloak"

step "Platform's client signs in to the customer's realm and lists users through its service account"
platform_secret=$(kubectl -n "$namespace" get secret libredb-keycloak-config -o 'jsonpath={.data.keycloak-client-libredb-platform}' | base64 -d)
client_token=$(curl -sf "${resolve[@]}" --cacert "$work/ca.crt" https://sso-ext.libredb.test/realms/corp/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=libredb-platform --data-urlencode "client_secret=$platform_secret" | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
status=$(curl -s "${resolve[@]}" --cacert "$work/ca.crt" -o /dev/null -w '%{http_code}' -H "authorization: Bearer $client_token" \
  https://sso-ext.libredb.test/admin/realms/corp/users?max=1)
[ "$status" = "200" ] || fail "libredb-platform's service account cannot list users: $status"
roles=$(curl -sf "${resolve[@]}" --cacert "$work/ca.crt" -H "authorization: Bearer $token" "https://sso-ext.libredb.test/admin/realms/corp/clients?clientId=libredb")
grep -q '"clientId":"libredb"' <<<"$roles" || fail "the realm holds no client libredb"

step "Studio's seal canary"
for _ in $(seq 1 30); do
  canary=$(kubectl -n corp exec corp-pg -- sh -c "PGPASSWORD='$superuser' psql -X -A -t -h 127.0.0.1 -U postgres -d libredb -c 'SELECT canary FROM bridge.studio_instances_v1'")
  grep -q '"ok"' <<<"$canary" && break
  sleep 5
done
grep -q '"ok"' <<<"$canary" || fail "Studio's seal canary is not ok: $canary"
step "the ingress serves the customer's certificates"
for url in https://platform-ext.libredb.test/api/health/ready https://studio-ext.libredb.test/api/ready; do
  status=$(curl -s "${resolve[@]}" --cacert "$work/ca.crt" -o /dev/null -w '%{http_code}' "$url")
  [ "$status" = "200" ] || fail "$url answered $status over the customer's certificate"
  echo "200 $url"
done
if kubectl -n "$namespace" get secret libredb-tls-platform >/dev/null 2>&1; then fail "tls.mode secrets wrote an ingress Secret of the internal CA"; fi

if [ "${LIBREDB_E2E_KEEP:-0}" != "1" ]; then
  step "cleanup"
  helm -n "$namespace" uninstall libredb --wait >/dev/null
  kubectl delete namespace "$namespace" corp --wait=true >/dev/null
fi
printf '\nPASS\n'
