# Install LibreDB on Kubernetes

This guide installs LibreDB 1.3.1 on a Kubernetes cluster with the Helm chart [`charts/libredb-platform`](../../charts/libredb-platform).
The chart is tested on vanilla Kubernetes, on clusters that Rancher manages and on OpenShift 4.
The chart deploys LibreDB Platform, its migrate job and LibreDB Studio under governance, and by default a PostgreSQL server and a Keycloak that it runs itself.
It is the installer's Kubernetes mode driven by Helm: the chart renders its values as an installation configuration of `mode: kubernetes`, and its jobs run the installer's own code on it, so a Helm install gets the same secrets, certificates, environments, PostgreSQL provisioning and Keycloak realm as a [Docker install](install-docker.md) of the same configuration.
The [chart README](../../charts/libredb-platform/README.md) lists every value.

## What you need

- Kubernetes 1.28 or newer, with a default StorageClass for the PostgreSQL volume and Platform's uploads.
- An ingress controller with an IngressClass, such as Traefik, HAProxy or ingress-nginx, which terminates TLS for the three hosts and accepts response headers of 16 KB: Platform's sign-in callback sets its session cookie in chunks, more than the 4 KB that nginx buffers by default.
  The chart sets `nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"` on its Ingresses for ingress-nginx; another nginx-based controller needs its own setting, or the first sign-in ends in a 502 from the controller.
- Helm 3.
- At least one x86_64 (amd64) node: the Platform image is built for linux/amd64 alone, so the chart schedules Platform and the jobs that run its image with `kubernetes.io/arch: amd64`; Studio, Keycloak and PostgreSQL also run on arm64 nodes.
- Three DNS names, for Platform, Studio and Keycloak, such as `libredb.acme.example`, `studio.acme.example` and `sso.acme.example`, which resolve to the ingress controller from the users' browsers **and from the cluster's pods**: Platform and Studio call Keycloak's issuer URL `https://<auth>/realms/libredb` from inside the cluster.
- A license file from LibreDB for the Platform host, as [Request a license](install-docker.md#request-a-license) describes.

One namespace holds one installation: the chart's objects have fixed names.

## Write the values

```sh
cat > libredb-values.yaml <<'EOF'
hosts:
  platform: libredb.acme.example
  studio: studio.acme.example
  auth: sso.acme.example
platform:
  organizationName: Acme Corp
studio:
  config:
    oidcIssuer: https://sso.acme.example/realms/libredb
  ingress:
    hosts:
      - host: studio.acme.example
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: libredb-tls-studio
        hosts: [studio.acme.example]
EOF
```

Helm passes no values down to a dependency, so the Studio host and the issuer appear twice; the chart refuses to render when the copies under `studio:` differ from `hosts`.
Set `ingress.className` and `studio.ingress.className` when the cluster has no default IngressClass.

## Install

Each installer release `installer-v<version>` publishes the chart under the same version: as `libredb-platform-<version>.tgz` of that GitHub release, in the Helm repository `https://libredb.org/libredb-platform/`, listed on Artifact Hub, and as an OCI artifact.
The first release with the chart is 1.1.1.

```sh
helm repo add libredb-platform https://libredb.org/libredb-platform/
helm repo update
helm install libredb libredb-platform/libredb-platform --version <version> -n libredb --create-namespace \
  -f libredb-values.yaml --set-file platform.license.value=acme.license \
  --wait --wait-for-jobs --timeout 10m
```

From the OCI registry, the same install names `oci://ghcr.io/libredb/charts/libredb-platform --version <version>` instead of `libredb-platform/libredb-platform`.
A published chart already holds the Studio chart it pins, so neither form needs the Studio repository.

From a checkout of this repository:

```sh
helm repo add libredb-studio https://libredb.org/libredb-studio/
helm dependency build charts/libredb-platform
helm install libredb charts/libredb-platform -n libredb --create-namespace \
  -f libredb-values.yaml --set-file platform.license.value=acme.license \
  --wait --wait-for-jobs --timeout 10m
```

In a checkout, `helm dependency build` takes the Studio chart that `Chart.lock` pins only from a repository Helm knows, so without the `helm repo add` it stops with `no repository definition for https://libredb.org/libredb-studio/`.
Instead of `--set-file`, `platform.license.existingSecret` names a Secret that holds the token under the key `license`.
The install runs in this order, and `--wait --wait-for-jobs` returns once every step is done:

1. The bootstrap hook generates the secrets, the seal keys and the internal CA, and writes every Secret and ConfigMap of the installation.
2. PostgreSQL starts with TLS from the internal CA, and the provisioning job runs the installer's provisioning script, which holds SCRAM verifiers only.
3. Keycloak starts, and the keycloak-configure job converges the realm `libredb`, its clients, roles and the two first accounts, as the installer does.
4. The migrate job migrates Platform's database once the PostgreSQL roles exist, and Platform turns ready.
5. Studio turns ready once Platform's bridge exists.

On a small cluster the whole install takes about a minute once the images are pulled.

## Check the license

```sh
kubectl -n libredb logs deploy/libredb-platform | grep -i licen
```

Expected: a line with `"message":"License active"`.
A license that does not name `hosts.platform` starts the install in state `invalid`, as [Check the license](install-docker.md#check-the-license) describes.

## Trust the internal CA

With the default `tls.mode: generated`, the internal CA issues the certificates of the three hosts, so every browser that opens them must trust it:

```sh
kubectl -n libredb get secret libredb-tls-platform -o jsonpath='{.data.ca\.crt}' | base64 -d > libredb-ca.crt
```

Import it only where the cluster's operators are trusted: the CA can sign a certificate for any name.
With certificates of your own, such as cert-manager's, set `tls.mode: secrets`, name the TLS Secret of each host in `tls.secrets` (and Studio's again as `studio.ingress.tls[0].secretName`), and give the CA that issued them in `tls.caBundle`, which every pod then trusts; a public CA's root works too.

## Sign in for the first time

```sh
kubectl -n libredb get secret libredb-keycloak-config -o jsonpath='{.data.first-admin-password}' | base64 -d; echo
```

Open the Platform host, choose Continue with SSO and sign in as `libredb-admin` with that temporary password.
Keycloak then asks for a new password and a TOTP device, as the [Docker guide](install-docker.md#sign-in-for-the-first-time) describes.
`libredb-user-manager` manages the realm's users in Keycloak's admin console, which the ingress does not expose:

```sh
kubectl -n libredb get secret libredb-keycloak-config -o jsonpath='{.data.user-manager-password}' | base64 -d; echo
kubectl -n libredb port-forward svc/keycloak 18080:8080
```

Then open `http://127.0.0.1:18080/admin/libredb/console/`, the admin URL a Docker install uses too.

## Back up and restore

The chart has no scheduled backups, so an installation with a managed PostgreSQL is backed up and restored by hand.
A backup is one set, taken together: the Secrets `libredb-secrets` (the seal keys, which open every database credential Platform stores, the role passwords and the client secrets), `libredb-tls` (the internal CA) and `libredb-installer-state`, and a `pg_dump -Fc` of the databases `libredb` and `keycloak`.
The Secrets must come from the same set as the databases, because the databases hold envelopes sealed to those keys.
Take the first set on day one; the set holds every secret of the installation, so store it like the secrets themselves.
With an external PostgreSQL, the site backs up its server, and the set is the three Secrets.

```sh
(
set -eu
BACKUP="libredb-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 0700 "$BACKUP"
kubectl -n libredb get secret libredb-secrets libredb-tls libredb-installer-state -o yaml > "$BACKUP/secrets.yaml"
for db in libredb keycloak; do
  kubectl -n libredb exec libredb-postgres-0 -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U postgres -Fc -d "$1"' sh "$db" > "$BACKUP/$db.dump"
done
echo "$BACKUP"
)
```

The bootstrap job's Secrets and ConfigMaps carry no Helm ownership, Platform's upload volume carries `helm.sh/resource-policy: keep`, and PostgreSQL's volume claim outlives its StatefulSet by Kubernetes' own rule, so `helm uninstall` leaves them, and a later install under the same release name in the same namespace reuses the seal keys, the CA, the database and the realm.
Deleting the namespace deletes them for good, and then only a backup set brings the installation back.

To restore a set into a new namespace or a new cluster:

1. Create the namespace under the same name: `secrets.yaml` names it, and `kubectl create` refuses it in another one.
   Put back the Secrets before the install, so the bootstrap job reuses them instead of generating new ones:

   ```sh
   kubectl create namespace libredb
   kubectl -n libredb create -f "$BACKUP/secrets.yaml"
   ```

2. Install the chart with the same values and license as before; it provisions empty databases with the restored role passwords and starts every component.
3. Stop the apps and Keycloak, which leaves PostgreSQL running, and put back each database; the archive recreates every object with its owner and its privileges:

   ```sh
   kubectl -n libredb scale deployment libredb-platform libredb-studio keycloak --replicas=0
   kubectl -n libredb wait --for=delete pod -l 'app.kubernetes.io/component in (platform,keycloak)' --timeout=180s
   kubectl -n libredb wait --for=delete pod -l app.kubernetes.io/name=studio --timeout=180s
   for db in libredb keycloak; do
     kubectl -n libredb exec -i libredb-postgres-0 -- sh -c \
       'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U postgres --clean --if-exists --exit-on-error -d "$1"' sh "$db" \
       < "$BACKUP/$db.dump"
   done
   kubectl -n libredb scale deployment libredb-platform libredb-studio keycloak --replicas=1
   ```

4. Review what the restore undid: every grant and revocation made after the backup point is gone, so a user whose access was withdrawn since then has it again; withdraw it again in Platform.

The [Docker runbook](../../installer/docs/runbooks/restore.md#a-database-copy-older-than-a-seal-key-retirement) covers a database copy older than a seal key retirement, which applies here alike.

## An existing PostgreSQL server

```yaml
postgresql:
  mode: external
  external:
    host: pg.acme.example
    port: 5432
    caBundle: |
      -----BEGIN CERTIFICATE-----
      ...
```

The host must be a DNS name its certificate covers: Platform and Studio connect with `sslmode=verify-full`.
The chart holds no admin credential of the server.
Its bootstrap job writes the provisioning script, with SCRAM verifiers only, to Secret `libredb-postgres-dba-script`, and a DBA runs it once, so install without waiting for the jobs, then let the DBA run the script, then wait:

```sh
helm install libredb charts/libredb-platform -n libredb --create-namespace -f libredb-values.yaml \
  --set-file platform.license.value=acme.license
kubectl -n libredb get secret libredb-postgres-dba-script -o jsonpath='{.data.provision\.sql}' | base64 -d > libredb-provision.sql
psql "host=pg.acme.example port=5432 dbname=postgres user=<admin> sslmode=verify-full sslrootcert=<CA file>" -f libredb-provision.sql
kubectl -n libredb wait --for=condition=complete job -l app.kubernetes.io/component=platform-migrate --timeout=10m
```

The migrate job waits until the roles exist; when the DBA runs the script later than the job's deadline of 15 minutes, `helm upgrade` with the same values runs it again.
The [connection budget](platform-runtime.md#connection-budget) applies to the external server.

## An existing Keycloak

```yaml
keycloak:
  mode: external
  realm: libredb
  external:
    baseUrl: https://sso.acme.example
    provisioning: installer
    adminSecret: keycloak-admin
    adminClientId: libredb-provisioner
```

With `provisioning: installer`, the keycloak-configure job converges the realm's LibreDB objects with the admin credential in the Secret that `adminSecret` names, under the key `admin-client-secret` for a client, or with `adminUser` and the key `admin-password` for a user of `adminRealm` (default `master`).
With `provisioning: manual`, your identity team configures the realm from `libredb-installer keycloak export` or [keycloak-manual.md](../../installer/docs/keycloak-manual.md), and `clientSecretsSecret` names a Secret with the keys `studio-client-secret` and `platform-client-secret`.
`hosts.auth` must be the host of `baseUrl`, and `caBundle` takes the CA of the Keycloak's certificate when a private CA issued it.

## The mobile app

The LibreDB mobile app signs in to Keycloak as a public client with the authorization code flow and PKCE S256, and calls Studio's API and Platform's API under `/api/v1` with its access token.
It is off unless the values enable it, as the installer's [`mobile` section](../../installer/README.md#mobile-app) does:

```yaml
mobile:
  enabled: true
  redirectUri: org.libredb.mobile:/oauth2redirect
  postLogoutRedirectUri: org.libredb.mobile:/oauth2redirect
```

Both URIs default to `org.libredb.mobile:/oauth2redirect`.
Each must be a private-use scheme in reverse domain name form, such as `org.libredb.mobile:`, or an `https://` URL, without a wildcard or a fragment; the bootstrap job checks them with the installer's schema and fails the install with exit 2 naming the value.
With a managed Keycloak, or an existing one with `provisioning: installer`, the keycloak-configure job creates the client `libredb-mobile` as the installer does: public, the standard flow only with PKCE S256, no direct access grants and no implicit flow, the two URIs, the default client scopes `basic`, `profile`, `email` and `libredb-roles`, and two audience mappers that add `libredb-studio-api` and `libredb-platform-api` to the access token only, so one token serves both apps.
With `provisioning: manual`, your identity team creates that client as [section 5 of keycloak-manual.md](../../installer/docs/keycloak-manual.md#5-client-libredb-mobile-only-with-the-mobile-app) describes; it has no secret, so `clientSecretsSecret` stays as it is.
Platform gets `PLATFORM_API_AUDIENCE=libredb-platform-api` and `PLATFORM_API_CLIENT_IDS=libredb-mobile` in Secret `libredb-platform-env`, and Studio gets `OIDC_BEARER_AUDIENCE=libredb-studio-api` and `OIDC_BEARER_CLIENT_IDS=libredb-mobile` in Secret `libredb-studio-network-env`, so each app accepts an access token only when its `aud` holds the app's audience and its `azp` is `libredb-mobile`; [docs/api/v1.md](../api/v1.md) describes Platform's checks.
The upgrade that turns it on or off restarts both apps.
Turning it off removes the four variables and leaves `libredb-mobile` in the realm, where an administrator deletes it in the console.

## Upgrade

```sh
helm upgrade libredb charts/libredb-platform -n libredb -f libredb-values.yaml \
  --set-file platform.license.value=acme.license --wait --wait-for-jobs --timeout 10m
```

Every upgrade runs the bootstrap hook, the provisioning, keycloak-configure and migrate jobs again, which converge without changing what is already right.
The apps read their Secrets and ConfigMaps when they start, so the bootstrap hook records each workload whose inputs it changed, and the restart hook, which runs once Helm applied the release, restarts it unless its pods already started after the change: Platform for its environment or the CA bundle, Studio for its Secrets or the CA bundle, Keycloak for its own, and PostgreSQL for a renewed leaf.
So a license renewal, a rotated client secret or a new CA reaches the apps with an upgrade, whether the value comes from these values or from a Secret you provide; nothing watches a Secret you provide between upgrades.
A request to restart outlives a failed run, and the next upgrade carries it out.
A downgrade is not supported: the bootstrap job, which runs before a rollback too, refuses an older release than the installation ran, so restore from a [backup](#back-up-and-restore) instead.
A rollback within the same release, such as one that undoes a wrong value, or the one `helm upgrade --atomic` runs after a failure, runs the bootstrap job with the earlier values; the installation counts a release as its own only once its upgrade succeeded.

Two Helm behaviours to know when something goes back:

- `helm rollback` to an older release fails at once on the bootstrap job's refusal, the earlier release keeps running, and Helm leaves the record of that rollback `pending-rollback`, which blocks the next operation. Remove that record, the revision `helm history libredb` shows as `pending-rollback`, with `kubectl -n libredb delete secret sh.helm.release.v1.libredb.v<revision>`, then continue with `helm upgrade`.
- When an upgrade fails in its bootstrap hook, nothing was applied, and the rollback of `--atomic` may still fail with `no Job with the name ... found`; the earlier release keeps running, and the next `helm upgrade` goes through.

## Rotate secrets and the seal key

Each step below is one `helm upgrade` with your values, as [Upgrade](#upgrade) runs it; keep what a step sets in your values file, because the next upgrade without it would undo it.
Back up Secret `libredb-secrets` before a rotation and keep that copy until the new values work, because a rollback cannot restore a secret value.
`PSQL` below is the managed server's superuser, for the checks:

```sh
PSQL='kubectl -n libredb exec -i libredb-postgres-0 -- sh -c "PGPASSWORD=\$POSTGRES_PASSWORD psql -X -h 127.0.0.1 -U postgres -d libredb"'
```

### The seal key

Platform seals every database credential to Studio's public seal key and can never open or re-seal one, so the rotation adds a key to Studio first, switches Platform to it, has an admin enter the credentials again, and only then retires the old key, as [the runbook of a Docker install](../../installer/docs/runbooks/seal-key-rotation.md) describes; `platform.sealKeys` stands for its `bridge.sealKeys`.

1. Note the kid that seals today's credentials, the second dot-separated field of each envelope, and the kids every live Studio instance holds:

   ```sh
   echo "SELECT instance_id, keyring_kids, canary FROM bridge.studio_instance WHERE last_seen_at > now() - interval '2 minutes'" | eval "$PSQL"
   ```

2. Set `platform.sealKeys.issueNew: true` and upgrade.
   The bootstrap job issues a new key into the secret store and Studio's keyring, and Studio restarts; Platform keeps sealing to the old key.
   Run the query of step 1 until every instance lists the new kid and still reports `ok` for the old one.
3. Set `issueNew: false` and `activeKid: <new kid>` in the same edit, and upgrade: Platform restarts with the new public key and publishes a canary for it; wait until every instance reports `ok` for the new kid.
   Upgrading with `issueNew: true` again issues no second key while the newest key is the active one.
4. Enter again, in the edit form of each connection, which warns about a credential sealed to an earlier key, every credential the old kid still seals; this query lists them, and must come back empty:

   ```sh
   echo "SELECT name, split_part(read_secret, '.', 2) AS read_kid, split_part(write_secret, '.', 2) AS write_kid FROM bridge.connections_v1" | eval "$PSQL"
   ```

   Re-entering a credential closes the affected users' Studio provider sessions, so schedule it outside working hours.
5. Keep `activeKid`, add `retire: [<old kid>]`, and upgrade.
   Before it changes anything, the bootstrap job asks PostgreSQL, as `libredb_platform`, which connections the old kid still seals, and while one does the upgrade fails at once (`pre-upgrade hooks failed`), its log naming each connection (`kubectl -n libredb logs job/libredb-bootstrap -c bootstrap`), and nothing changes; enter those credentials and upgrade again.
   Otherwise the old key leaves Studio's keyring, the secret store keeps it in escrow as `retired` for a restore of an older backup, and the restart job deletes its canary row before it restarts Studio.
   Leave the kid in `retire`.

### Generated secrets

The bootstrap job generates every secret of the installation once, into Secret `libredb-secrets`, and never replaces one it holds, so a rotation deletes the value there and upgrades; the upgrade generates a new value and every consumer follows in the same run: the Keycloak client, the PostgreSQL role, the apps' Secrets, and the restart job restarts what reads them.

```sh
kubectl -n libredb patch secret libredb-secrets --type json -p '[{"op":"remove","path":"/data/<name>"}]'
```

| Name | Effect of a new value |
| --- | --- |
| `studio-jwt-secret` | Studio's session cookies: every Studio user is signed out, and signs in again without a password while the Keycloak session lives |
| `platform-auth-secret` | Platform's session cookies: give the previous value as below, so the sessions survive |
| `keycloak-client-libredb-studio`, `keycloak-client-libredb-platform` | The clients' secrets: sign-in fails only between the keycloak-configure job and the app's restart |
| `postgres-owner-password`, `postgres-platform-password`, `postgres-studio-password`, `postgres-keycloak-password` | The roles' passwords, which the provisioning job sets; open connections keep working, a new one with the old password fails until its app restarted |

Platform keeps its sessions through a rotation of `platform-auth-secret` when the previous value stays for one session lifetime, 8 days:

```sh
(umask 077 && kubectl -n libredb get secret libredb-secrets -o 'jsonpath={.data.platform-auth-secret}' | base64 -d > auth-previous)
kubectl -n libredb create secret generic libredb-auth-previous --from-file=auth-secret-previous=auth-previous && rm auth-previous
kubectl -n libredb patch secret libredb-secrets --type json -p '[{"op":"remove","path":"/data/platform-auth-secret"}]'
```

Upgrade with `platform.authSecretPrevious.existingSecret: libredb-auth-previous`; after 8 days, upgrade without it and delete the Secret.
To end every Platform session at once, skip the previous value.

`postgres-superuser-password` (the managed server reads it only when it creates its data directory), `postgres-backup-password` and `studio-storage-encryption-key` (Studio's stored data is encrypted with it) are not rotated this way.

## Differences from a Docker install

- The ingress controller replaces the installer's Caddy edge for Platform and Studio; a managed Keycloak keeps the installer's edge as a sidecar, so only `/realms/<realm>/` and `/resources/` reach it.
- The managed Keycloak keeps its bootstrap admin client in realm `master`: Keycloak would recreate it from its Deployment's environment on the next start. Its secret is in Secrets `libredb-secrets`, `libredb-keycloak-env` and `libredb-keycloak-config` and in Keycloak's environment; Keycloak's port 8080, which serves the Admin API in-cluster over plain HTTP, accepts only this release's pods while `networkPolicy.enabled` is true (the default) and the cluster's CNI enforces network policies.
- There is no renewal timer: any `helm upgrade` re-issues a leaf of the internal CA that has fewer than 30 days left and restarts PostgreSQL for its own; the ingress controller picks up a renewed ingress certificate by itself. The leaves are valid for 825 days, so run an upgrade at least once in that time.
- Secrets and the seal key are rotated with values and upgrades, as [Rotate secrets and the seal key](#rotate-secrets-and-the-seal-key) describes, not with the installer's `apply`.
- This release runs one replica of each component.

## Security notes

- Every pod runs under the restricted Pod Security Standard, so the namespace may enforce it (`pod-security.kubernetes.io/enforce=restricted`); the managed Keycloak's edge adds only the capability `NET_BIND_SERVICE`, which its binary carries.
- The bootstrap hook's ServiceAccount may create Secrets and ConfigMaps in the namespace, which Kubernetes cannot limit by name, and read and replace only the installation's own objects; it exists only while the hook runs, and a failed hook leaves it until the next run replaces it.
- The containers have memory limits and no CPU limit, so a busy pod is never throttled; set `resources.limits.cpu` of each component where a policy requires one.
- `networkPolicy.enabled` guards PostgreSQL and Keycloak's Admin API; Platform and Studio take traffic from the ingress controller, whose namespace differs per cluster, so a policy for them is yours to add.
- `network.httpsProxy` must hold no credentials: it is part of the installation document, a ConfigMap.
- A license given inline lands in Helm's release Secrets; with GitOps, keep it in a Secret of your own and name it in `platform.license.existingSecret`.

## Argo CD

The chart works as an Argo CD application from a Git checkout or a packaged chart:

- Argo CD runs the bootstrap job as a PreSync hook, the provisioning, keycloak-configure and migrate jobs as Sync hooks, which it replaces on every sync, and the restart job as a PostSync hook, so each sync converges as a `helm upgrade` does.
- The objects the jobs write carry the label `install.libredb.org/installation`, never a tracking label, and the annotations `argocd.argoproj.io/sync-options: Prune=false,Delete=false` and `argocd.argoproj.io/compare-options: IgnoreExtraneous`, so a prune never deletes the seal keys.
- Give the license as `platform.license.existingSecret`.
- Argo CD counts an Ingress healthy only once the ingress controller publishes an address on it, as a cloud load balancer's controller does; a controller behind a NodePort needs its published address set, such as Traefik's `providers.kubernetesIngress.ingressEndpoint.ip`, or the app stays Progressing.

## OpenShift

The chart installs on OpenShift 4 with the default `restricted-v2` SCC and namespace-scoped rights only, as in a Red Hat Developer Sandbox:

- With `global.compatibility.openshift.adaptSecurityContext: auto`, the default, the chart sees `security.openshift.io/v1` and leaves out the pods' fixed `runAsUser`, `runAsGroup` and `fsGroup`, so the SCC assigns them from the namespace's range; the Studio chart reads the same value. `force` does the same where Helm cannot ask the API server, such as `helm template` for GitOps, and `disabled` keeps the fixed ids, for an SCC that allows them.
- OpenShift turns each Ingress into a Route that terminates TLS at the router with the Ingress's Secret, so `tls.mode: generated` works unchanged; the hosts are names under the cluster's apps domain, or names your DNS points at the router.
- The project template may add NetworkPolicies of its own, such as an `allow-same-namespace` policy, and policies add up: there, every pod of the namespace reaches PostgreSQL and Keycloak's Admin API, so give the installation a namespace of its own.

## An install without network access

`helm dependency build` fetches the pinned Studio chart from `https://libredb.org/libredb-studio/`.
For a site without that access, run `helm package --dependency-update charts/libredb-platform` on a machine that has it and install the archive, which holds the dependency, so Helm on the site needs no repository.
The images come from the registries in `values.yaml`; copy the five of them into your mirror with their digests, for example with `docker buildx imagetools create -t <mirror>/<repository>:<tag> <image>` or `skopeo copy --all`, and point the chart at it, keeping the tags, which pin each image by digest:

```sh
helm install libredb libredb-platform-<version>.tgz -n libredb -f values.yaml --set-file platform.license.value=acme.license \
  --set platform.image.repository=<mirror>/libredb/libredb-platform \
  --set postgresql.managed.image.repository=<mirror>/library/postgres \
  --set keycloak.managed.image.repository=<mirror>/keycloak/keycloak \
  --set keycloak.managed.edge.image.repository=<mirror>/library/caddy \
  --set studio.image.repository=<mirror>/libredb/libredb-studio
```

## End-to-end test

[`charts/libredb-platform/tests/e2e/run-e2e.sh`](../../charts/libredb-platform/tests/e2e/run-e2e.sh) installs the chart on a local kind cluster into a namespace that enforces the restricted Pod Security Standard, checks the endpoints, the network policies, the license and Studio's seal canary, runs the browser suite of [`installer/e2e/kubernetes`](../../installer/e2e/kubernetes), upgrades, uninstalls and installs again, then upgrades with `mobile.enabled`, checks both apps' bearer settings and that a PKCE sign-in through `libredb-mobile` yields an access token with both audiences and `azp` `libredb-mobile`, and turns it off again; it needs a license for `platform.libredb.test`.
[`run-external.sh`](../../charts/libredb-platform/tests/e2e/run-external.sh) then installs against a PostgreSQL and a Keycloak of a simulated customer, with the customer's TLS Secrets and a license Secret; it needs a license for `platform-ext.libredb.test`.
On the installation run-e2e.sh leaves running (`LIBREDB_E2E_KEEP=1`), [`run-lifecycle.sh`](../../charts/libredb-platform/tests/e2e/run-lifecycle.sh) renews leaves that expire in 10 days and walks a license through expiring, expired and active, [`run-upgrade.sh`](../../charts/libredb-platform/tests/e2e/run-upgrade.sh) upgrades to the chart of a later release, with a failed `--atomic` attempt first, and checks that going back is refused, and [`run-argocd.sh`](../../charts/libredb-platform/tests/e2e/run-argocd.sh) installs Argo CD with label tracking and syncs the packaged chart with automated prune.
`LIBREDB_E2E_EXISTING_CLUSTER=1` runs run-e2e.sh against the cluster of `KUBECONFIG`, such as from a container on kind's network.
[`run-restore.sh`](../../charts/libredb-platform/tests/e2e/run-restore.sh) takes the backup set above, deletes the namespace with its volumes and restores the set, then signs the first admin in with the password of the backup and has a user read a table through a credential sealed before it; [`run-offline.sh`](../../charts/libredb-platform/tests/e2e/run-offline.sh) installs the packaged archive with no Helm repository and no way out, every image from a mirror.
[`run-rotation.sh`](../../charts/libredb-platform/tests/e2e/run-rotation.sh) walks [Rotate secrets and the seal key](#rotate-secrets-and-the-seal-key) with a granted user querying throughout; [`run-resilience.sh`](../../charts/libredb-platform/tests/e2e/run-resilience.sh) kills PostgreSQL, then Platform, Studio and Keycloak at once, then restarts the node, and checks after each that the endpoints come back on their own and no data was lost; [`run-soak.sh`](../../charts/libredb-platform/tests/e2e/run-soak.sh) leaves one installation running for hours and records availability, memory, restarts and growth.
[`run-openshift.sh`](../../charts/libredb-platform/tests/e2e/run-openshift.sh) runs the same checks and the browser suite in the namespace of the current `oc login`, with the hosts `ldb-<app>-<namespace>.<apps domain>`, and checks that `restricted-v2` admits every pod with a uid from the namespace's range.
