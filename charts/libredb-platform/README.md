# libredb-platform Helm chart

LibreDB Platform, database access governance, with LibreDB Studio, on Kubernetes.
The guide is [docs/deploy/install-kubernetes.md](../../docs/deploy/install-kubernetes.md); this file lists the values.
LibreDB Platform is source-available under the Elastic License 2.0, and every install needs a license from LibreDB.

The chart is the installer's Kubernetes mode driven by Helm.
It renders the values as an installation configuration of `mode: kubernetes`, which its jobs validate with the installer's schema and turn into Secrets, certificates, environments, a PostgreSQL provisioning script and a Keycloak realm with the installer's own code, bundled in `files/libredb-jobs.cjs.gz` (`bun run build:helm-jobs` in `installer/` rebuilds it; a unit test fails while it is stale).

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

## What it deploys

| Object | When |
| --- | --- |
| Job `libredb-bootstrap` (pre-install, pre-upgrade and pre-rollback hook) with its ServiceAccount and Role | always |
| StatefulSet and Service `libredb-postgres`, provisioning Job | `postgresql.mode: managed` |
| Deployment and Services `keycloak` and `keycloak-edge`, Ingress `keycloak` | `keycloak.mode: managed` |
| Job `libredb-keycloak-configure-<hash>` | a managed Keycloak, or `keycloak.external.provisioning: installer` |
| Job `libredb-platform-migrate-<hash>` | always |
| Job `libredb-restart` (post-install, post-upgrade and post-rollback hook) with its ServiceAccount and Role | always |
| Deployment, Service, Ingress and PVC `libredb-platform` | always |
| The Studio chart (pinned by the release manifest) under governance | `studio.enabled` |
| NetworkPolicies `libredb-postgres` and `keycloak` | `networkPolicy.enabled` |

The bootstrap job writes `libredb-secrets` (generated secrets and seal keys, never replaced), `libredb-tls` (internal CA and leaves), `libredb-platform-env`, `libredb-platform-migrate-env`, `libredb-studio-env`, `libredb-keycloak-config`, `libredb-ca` and the objects of the managed PostgreSQL and Keycloak.
They carry no Helm ownership and outlive `helm uninstall`; back up `libredb-secrets` and `libredb-tls`.
When one of them changes, the restart job restarts the workloads that read it, once Helm applied the release.

## Values

| Value | Default | Meaning |
| --- | --- | --- |
| `installation.name` | `libredb` | The installation's name, which names the internal CA |
| `hosts.platform`, `hosts.studio`, `hosts.auth` | | Required: the public hosts, resolvable from browsers and from the cluster's pods |
| `platform.organizationName` | | Required: the name of the installation's one tenant |
| `platform.queryLogRetentionDays` | `null` (90) | Days Platform keeps query events |
| `platform.license.value` | | The license token; pass it with `--set-file` |
| `platform.license.existingSecret`, `platform.license.key` | `""`, `license` | Or a Secret that holds the token |
| `platform.image` | the release's, by digest | Platform's image |
| `platform.resources`, `nodeSelector`, `tolerations`, `affinity`, `podAnnotations`, `podLabels` | | Platform's pod; `nodeSelector` and `tolerations` also place the jobs that run the Platform image, and `nodeSelector` holds `kubernetes.io/arch: amd64` unless it names another arch |
| `platform.persistence.enabled`, `size`, `storageClass`, `accessModes` | `true`, `5Gi` | Support attachments under `/app/uploads` |
| `tls.mode` | `generated` | `generated`: the internal CA issues the ingress certificates; `secrets`: your TLS Secrets |
| `tls.secrets.platform`, `studio`, `auth` | | With `tls.mode: secrets`, the TLS Secret of each host (`auth` only with a managed Keycloak); repeat `studio` as `studio.ingress.tls[0].secretName` |
| `tls.caBundle` | | With `tls.mode: secrets`, the PEM of the CA that issued them (required) |
| `ingress.enabled`, `className`, `annotations` | `true`, `""`, `nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"` | The Ingress of Platform and of a managed Keycloak; the annotation gives ingress-nginx room for the response headers of Platform's sign-in callback, and other controllers ignore it |
| `postgresql.mode` | `managed` | `managed` or `external` |
| `postgresql.managed.image`, `persistence.size`, `persistence.storageClass`, `resources`, `nodeSelector`, `tolerations`, `affinity` | the release's image, `10Gi` | The managed server |
| `postgresql.external.host`, `port`, `caBundle` | `""`, `5432` | The external server, provisioned once by a DBA with Secret `libredb-postgres-dba-script` |
| `keycloak.mode` | `managed` | `managed` or `external` |
| `keycloak.realm` | `libredb` | The realm |
| `keycloak.firstAdmin.enabled`, `username` | `null`, `libredb-admin` | The first admin account; enabled by default with a managed Keycloak |
| `keycloak.userManager.enabled`, `username` | `null`, `libredb-user-manager` | The user manager account; enabled by default with a managed Keycloak |
| `keycloak.managed.image`, `resources`, `nodeSelector`, `tolerations`, `affinity` | the release's image | The managed Keycloak |
| `keycloak.managed.edge.image`, `resources` | the release's Caddy | The installer's edge in front of Keycloak's public paths |
| `keycloak.external.baseUrl`, `adminUrl` | | Your Keycloak; `hosts.auth` must be the host of `baseUrl` |
| `keycloak.external.provisioning` | `installer` | `installer`: the chart's job configures the realm; `manual`: your identity team does |
| `keycloak.external.adminRealm`, `adminSecret`, `adminClientId`, `adminUser` | `master` | With `installer`: the Secret with `admin-client-secret` (client) or `admin-password` (user) |
| `keycloak.external.clientSecretsSecret` | | With `manual`: the Secret with `studio-client-secret` and `platform-client-secret` |
| `keycloak.external.caBundle` | | The PEM of your Keycloak's CA, when a private CA issued its certificate |
| `network.httpsProxy` | | An http(s) proxy for the apps' outbound HTTPS, without credentials |
| `jobs.backoffLimit`, `activeDeadlineSeconds`, `resources` | `6`, `900` | The chart's jobs |
| `networkPolicy.enabled` | `true` | PostgreSQL and Keycloak's Admin API reachable only from this release's pods |
| `platform.sealKeys.issueNew`, `activeKid`, `retire` | `false`, `""`, `[]` | The seal key rotation, one upgrade per step; see the guide's "Rotate secrets and the seal key" |
| `platform.authSecretPrevious.existingSecret`, `key` | `""`, `auth-secret-previous` | During a rotation of Platform's `AUTH_SECRET`, a Secret with the previous value |
| `global.compatibility.openshift.adaptSecurityContext` | `auto` | `auto` leaves the pods' uids to OpenShift's SCC when the cluster is OpenShift, `force` always, `disabled` never; Studio reads it too |
| `imagePullSecrets` | `[]` | For every pod of the chart (Studio has its own under `studio:`) |
| `studio.*` | governance defaults | The Studio chart's values; repeat `hosts.studio` in `studio.ingress` and the issuer in `studio.config.oidcIssuer` |

The chart refuses to render, naming the value, when a required value is missing or two copies of a host or the issuer disagree.

## Tests

- `installer/test/unit/kubernetes/chart.test.ts` renders the chart with `helm template` and holds it to the installer: render guards, the installation document against the schema, the release manifest's pins, Studio's and Keycloak's environments against the installer's renderers, the bootstrap Role against every object the job writes, and the pods' security.
- `tests/e2e/run-e2e.sh` installs on a local kind cluster and runs the browser suite of `installer/e2e/kubernetes`.
- `tests/e2e/run-openshift.sh` does the same on OpenShift, in the namespace of the current `oc login`, under the `restricted-v2` SCC.
- `tests/e2e/run-rotation.sh` rotates the seal key and the generated secrets; `tests/e2e/run-resilience.sh` kills pods and restarts the node; `tests/e2e/run-soak.sh` runs one installation for hours.
- `tests/e2e/run-restore.sh` backs up, deletes the namespace and restores; `tests/e2e/run-offline.sh` installs the packaged archive from an image mirror with no network for Helm.
