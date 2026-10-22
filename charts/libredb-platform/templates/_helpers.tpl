{{/*
Names. Every object has a fixed name, like the installer's Kubernetes constants (installer/src/kubernetes/names.ts),
so a namespace holds one installation; installer/test/unit/kubernetes/chart.test.ts holds the bootstrap Role's names
to the objects the bootstrap job writes.
*/}}

{{- define "libredb-platform.labels" -}}
app.kubernetes.io/name: libredb-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: libredb
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}

{{/* Selector labels of one component: platform, postgres, keycloak or a job. */}}
{{- define "libredb-platform.selectorLabels" -}}
app.kubernetes.io/name: libredb-platform
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "libredb-platform.image" -}}
{{- printf "%s:%s" .repository .tag }}
{{- end }}

{{- define "libredb-platform.managedPostgres" -}}
{{- if eq .Values.postgresql.mode "managed" }}true{{ end }}
{{- end }}

{{- define "libredb-platform.managedKeycloak" -}}
{{- if eq .Values.keycloak.mode "managed" }}true{{ end }}
{{- end }}

{{/* Whether the chart runs the keycloak-configure job: a managed Keycloak, or an external one with provisioning installer. */}}
{{- define "libredb-platform.keycloakJob" -}}
{{- if or (include "libredb-platform.managedKeycloak" .) (eq .Values.keycloak.external.provisioning "installer") }}true{{ end }}
{{- end }}

{{- define "libredb-platform.issuer" -}}
{{- if include "libredb-platform.managedKeycloak" . -}}
{{- printf "https://%s/realms/%s" .Values.hosts.auth .Values.keycloak.realm }}
{{- else -}}
{{- printf "%s/realms/%s" (trimSuffix "/" .Values.keycloak.external.baseUrl) .Values.keycloak.realm }}
{{- end }}
{{- end }}

{{/* Where the bootstrap job finds the operator's inputs, as the installation document names them. */}}
{{- define "libredb-platform.inputDir" -}}/etc/libredb/inputs{{- end }}

{{/*
The installation document: the Helm values as a LibreDBInstallation of mode kubernetes, which the jobs validate with
the installer's schema (installer/src/config/schema.ts). It holds no secret, only the files that hold them.
*/}}
{{- define "libredb-platform.installation" -}}
{{- $in := include "libredb-platform.inputDir" . -}}
{{- $tls := dict "mode" "generated" -}}
{{- if eq .Values.tls.mode "secrets" -}}
{{- $tls = dict "mode" "external" "caBundleFile" (printf "%s/ca/tls-ca.crt" $in) "external" (dict "trustedProxies" (list "private_ranges")) -}}
{{- end -}}
{{- $postgres := dict "mode" "managed" -}}
{{- if eq .Values.postgresql.mode "external" -}}
{{- $ext := dict "host" .Values.postgresql.external.host "port" (int .Values.postgresql.external.port) "provisioning" "manual" -}}
{{- if .Values.postgresql.external.caBundle }}{{ $_ := set $ext "caBundleFile" (printf "%s/ca/postgres-ca.crt" $in) }}{{ end -}}
{{- $postgres = dict "mode" "external" "external" $ext -}}
{{- end -}}
{{- $kc := .Values.keycloak -}}
{{- $account := dict "firstAdmin" (dict "username" $kc.firstAdmin.username) "userManager" (dict "username" $kc.userManager.username) -}}
{{- if not (kindIs "invalid" $kc.firstAdmin.enabled) }}{{ $_ := set $account.firstAdmin "enabled" $kc.firstAdmin.enabled }}{{ end -}}
{{- if not (kindIs "invalid" $kc.userManager.enabled) }}{{ $_ := set $account.userManager "enabled" $kc.userManager.enabled }}{{ end -}}
{{- $keycloak := dict "mode" $kc.mode "realm" $kc.realm "firstAdmin" $account.firstAdmin "userManager" $account.userManager -}}
{{- if eq $kc.mode "external" -}}
{{- $x := $kc.external -}}
{{- $ext := dict "baseUrl" $x.baseUrl "provisioning" $x.provisioning -}}
{{- if $x.adminUrl }}{{ $_ := set $ext "adminUrl" $x.adminUrl }}{{ end -}}
{{- if $x.caBundle }}{{ $_ := set $ext "caBundleFile" (printf "%s/ca/keycloak-ca.crt" $in) }}{{ end -}}
{{- if eq $x.provisioning "installer" -}}
{{- $_ := set $ext "adminRealm" $x.adminRealm -}}
{{- if $x.adminClientId -}}
{{- $_ := set $ext "adminClientId" $x.adminClientId -}}
{{- $_ := set $ext "adminClientSecretFile" (printf "%s/keycloak-admin/admin-client-secret" $in) -}}
{{- end -}}
{{- if $x.adminUser -}}
{{- $_ := set $ext "adminUser" $x.adminUser -}}
{{- $_ := set $ext "adminPasswordFile" (printf "%s/keycloak-admin/admin-password" $in) -}}
{{- end -}}
{{- else -}}
{{- $_ := set $ext "studioClientSecretFile" (printf "%s/keycloak-clients/studio-client-secret" $in) -}}
{{- $_ := set $ext "platformClientSecretFile" (printf "%s/keycloak-clients/platform-client-secret" $in) -}}
{{- end -}}
{{- $_ := set $keycloak "external" $ext -}}
{{- end -}}
{{- $platform := dict "organizationName" .Values.platform.organizationName "licenseFile" (printf "%s/license/license" $in) -}}
{{- if .Values.platform.authSecretPrevious.existingSecret }}{{ $_ := set $platform "authSecretPreviousFile" (printf "%s/auth-secret-previous/auth-secret-previous" $in) }}{{ end -}}
{{- if not (kindIs "invalid" .Values.platform.queryLogRetentionDays) }}{{ $_ := set $platform "queryLogRetentionDays" (int .Values.platform.queryLogRetentionDays) }}{{ end -}}
{{- $doc := dict "apiVersion" "install.libredb.org/v1" "kind" "LibreDBInstallation" "metadata" (dict "name" .Values.installation.name) "mode" "kubernetes" "endpoints" (dict "style" "hostnames" "hosts" .Values.hosts) "tls" $tls "postgres" $postgres "keycloak" $keycloak "platform" $platform "kubernetes" (dict "namespace" .Release.Namespace) -}}
{{- if .Values.network.httpsProxy }}{{ $_ := set $doc "network" (dict "httpsProxy" .Values.network.httpsProxy) }}{{ end -}}
{{- $seal := .Values.platform.sealKeys -}}
{{- $sealKeys := dict "issueNew" $seal.issueNew "retire" (include "libredb-platform.retiredKids" . | fromJsonArray) -}}
{{- if $seal.activeKid }}{{ $_ := set $sealKeys "activeKid" (include "libredb-platform.kid" (dict "value" $seal.activeKid "name" "platform.sealKeys.activeKid")) }}{{ end -}}
{{- $_ := set $doc "bridge" (dict "sealKeys" $sealKeys) -}}
{{- toPrettyJson $doc }}
{{- end }}

{{/* A seal key id, 16 lowercase hex digits, or a failed render that names the value: dict "value" "name". */}}
{{- define "libredb-platform.kid" -}}
{{- if not (regexMatch "^[0-9a-f]{16}$" (toString .value)) }}{{ fail (printf "%s: %q is no seal key id, which is 16 lowercase hex digits" .name (toString .value)) }}{{ end -}}
{{- .value -}}
{{- end }}

{{/* platform.sealKeys.retire as a JSON array, each kid checked, since the jobs' SQL quotes them as literals. */}}
{{- define "libredb-platform.retiredKids" -}}
{{- $kids := list -}}
{{- range $index, $kid := .Values.platform.sealKeys.retire -}}
{{- $kids = append $kids (include "libredb-platform.kid" (dict "value" $kid "name" (printf "platform.sealKeys.retire[%d]" $index))) -}}
{{- end -}}
{{- toJson $kids -}}
{{- end }}

{{/*
The installer's envelopeUsesScript (installer/src/secrets/seal-rotation.ts) for platform.sealKeys.retire, which the
bootstrap job's seal-envelopes init container runs as libredb_platform; installer/test/unit/kubernetes/chart.test.ts
holds the two to the same text.
*/}}
{{- define "libredb-platform.sealEnvelopesSql" -}}
{{- $quoted := list -}}
{{- range (include "libredb-platform.retiredKids" . | fromJsonArray) }}{{ $quoted = append $quoted (printf "'%s'" .) }}{{ end -}}
SELECT 'libredb-result envelope-uses ' || ((SELECT coalesce(jsonb_agg(jsonb_build_object('kid', e.kid, 'connectionId', e.connection_id::text, 'name', e.name) ORDER BY e.kid, e.name), '[]'::jsonb) FROM (SELECT connection_id, name, split_part(read_secret, '.', 2) AS kid FROM bridge.connections_v1 UNION SELECT connection_id, name, split_part(write_secret, '.', 2) FROM bridge.connections_v1 WHERE write_secret IS NOT NULL) e WHERE e.kid IN ({{ join ", " $quoted }})))::text;
{{ end }}

{{/* The installer's deleteCanaryScript for each retired kid, which the restart job runs once the release applied. */}}
{{- define "libredb-platform.sealCanarySql" -}}
{{- range (include "libredb-platform.retiredKids" . | fromJsonArray) -}}
DELETE FROM platform.seal_canary WHERE kid = '{{ . }}';
{{ end -}}
{{- end }}

{{/*
An init container that runs one SQL file of the chart as libredb_platform over verified TLS, with the role's password
from Secret libredb-platform-migrate-env in PGPASSWORD, never on a command line: dict "root" . "name" "file" "output".
*/}}
{{- define "libredb-platform.platformSqlContainer" -}}
- name: {{ .name }}
  image: {{ include "libredb-platform.image" .root.Values.postgresql.managed.image }}
  imagePullPolicy: {{ .root.Values.postgresql.managed.image.pullPolicy }}
  command:
    - /bin/sh
    - -c
    - |
      set -eu
      rest="${DATABASE_URL#postgresql://libredb_platform:}"
      export PGPASSWORD="${rest%%@*}"
      address="${rest#*@}"
      address="${address%%/*}"
      conninfo="host=${address%:*} port=${address##*:} dbname=libredb user=libredb_platform sslmode=verify-full sslrootcert=/etc/libredb/ca/ca.crt connect_timeout=10"
      psql "$conninfo" -X -q -A -t -v ON_ERROR_STOP=1 -f {{ .file }}{{ with .output }} > {{ . }}{{ end }}
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: libredb-platform-migrate-env
          key: DATABASE_URL
  securityContext:
    {{- include "libredb-platform.containerSecurity" .root | nindent 4 }}
  resources:
    {{- toYaml .root.Values.jobs.resources | nindent 4 }}
  volumeMounts:
    - name: installation-ca
      mountPath: /etc/libredb/ca
      readOnly: true
    - name: chart
      mountPath: /etc/libredb/chart
      readOnly: true
    - name: tmp
      mountPath: /tmp
{{- end }}

{{- define "libredb-platform.chartSettings" -}}
{{- /* No Helm or Argo CD tracking label (app.kubernetes.io/instance): a tool that tracked these objects would prune them. */}}
{{- toPrettyJson (dict "studioSecretName" .Values.studio.secrets.existingSecret "labels" (dict "app.kubernetes.io/part-of" "libredb" "app.kubernetes.io/managed-by" "libredb-bootstrap" "install.libredb.org/installation" .Values.installation.name)) }}
{{- end }}

{{/* A short hash that names a job after what it runs, so a changed job is a new Job and an unchanged one stays done. */}}
{{- define "libredb-platform.hash" -}}
{{- . | sha256sum | trunc 8 }}
{{- end }}

{{/* The restricted security context of every LibreDB container (uid 1001, as the installer's compose file). */}}
{{- define "libredb-platform.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Whether to leave out the pods' fixed uids for OpenShift, whose restricted-v2 SCC assigns runAsUser and fsGroup from the
namespace's range and rejects any other: global.compatibility.openshift.adaptSecurityContext, the value the Studio
chart reads too, "auto" when the API server serves security.openshift.io/v1, "force" always, "disabled" never.
*/}}
{{- define "libredb-platform.adaptOpenShift" -}}
{{- $mode := dig "compatibility" "openshift" "adaptSecurityContext" "auto" (.Values.global | default dict) }}
{{- if or (eq $mode "force") (and (eq $mode "auto") (.Capabilities.APIVersions.Has "security.openshift.io/v1")) }}
{{- true }}
{{- end }}
{{- end }}

{{/* The pod security context, with the image's uid unless OpenShift assigns one: dict "root" . "uid" <uid>. */}}
{{- define "libredb-platform.podSecurity" -}}
runAsNonRoot: true
{{- if not (include "libredb-platform.adaptOpenShift" .root) }}
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
{{- end }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Where a pod of the Platform image may run: platform.nodeSelector and platform.tolerations, with kubernetes.io/arch amd64
unless platform.nodeSelector names another, since the Platform image is built for linux/amd64 alone. Platform and the
jobs that run its image share it, so a job never lands on a node the image cannot run on.
*/}}
{{- define "libredb-platform.platformScheduling" -}}
nodeSelector:
  {{- toYaml (merge (dict) .Values.platform.nodeSelector (dict "kubernetes.io/arch" "amd64")) | nindent 2 }}
{{- with .Values.platform.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
The node command of a chart job: the gzipped bundle decompressed into /tmp, then run with the cluster CA and, for the
keycloak job, the installation's CA bundle trusted.
*/}}
{{- define "libredb-platform.jobCommand" -}}
- /bin/sh
- -c
- |
  set -eu
  cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt {{ if .withBundle }}/etc/libredb/ca/ca.crt {{ end }}> /tmp/trust.pem
  node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("/tmp/libredb-jobs.cjs",z.gunzipSync(f.readFileSync("/etc/libredb/jobs/libredb-jobs.cjs.gz")))'
  NODE_EXTRA_CA_CERTS=/tmp/trust.pem exec node /tmp/libredb-jobs.cjs {{ .command }}
{{- end }}

{{/*
An init container that waits until the installation's PostgreSQL server accepts connections, so a job that starts
beside a server that is still starting waits instead of failing. pg_isready checks the protocol, without credentials.
*/}}
{{- define "libredb-platform.waitForPostgres" -}}
- name: wait-for-postgres
  image: {{ include "libredb-platform.image" .Values.postgresql.managed.image }}
  imagePullPolicy: {{ .Values.postgresql.managed.image.pullPolicy }}
  command:
    - /bin/sh
    - -c
    - |
      until pg_isready -q -t 5 -h "$PGHOST" -p "$PGPORT"; do echo "waiting for PostgreSQL at $PGHOST:$PGPORT"; sleep 3; done
  env:
    # libpq looks the OS user up when PGUSER is unset, which fails for a uid the image has no passwd entry for.
    - name: PGUSER
      value: postgres
    - name: PGHOST
      value: {{ if include "libredb-platform.managedPostgres" . }}libredb-postgres{{ else }}{{ .Values.postgresql.external.host | quote }}{{ end }}
    - name: PGPORT
      value: {{ if include "libredb-platform.managedPostgres" . }}"5432"{{ else }}{{ .Values.postgresql.external.port | quote }}{{ end }}
  securityContext:
    {{- include "libredb-platform.containerSecurity" . | nindent 4 }}
  resources:
    {{- toYaml .Values.jobs.resources | nindent 4 }}
{{- end }}

{{/*
Render guards: every combination the installation could not run with fails here, naming the value, before anything
reaches the cluster. The installer schema checks the rest in the bootstrap job.
*/}}
{{- define "libredb-platform.guards" -}}
{{- range $endpoint := list "platform" "studio" "auth" }}
{{- if not (get $.Values.hosts $endpoint) }}
{{- fail (printf "hosts.%s is required: the public host of %s" $endpoint $endpoint) }}
{{- end }}
{{- end }}
{{- if not .Values.platform.organizationName }}
{{- fail "platform.organizationName is required: the name of the installation's one tenant" }}
{{- end }}
{{- if and (not .Values.platform.license.value) (not .Values.platform.license.existingSecret) }}
{{- fail "platform.license is required: every install needs a license from LibreDB (info@libredb.org); pass it with --set-file platform.license.value=<file>, or name a Secret in platform.license.existingSecret" }}
{{- end }}
{{- if and .Values.platform.license.value (not (regexMatch "^ldl1\\.[0-9a-f]{16}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" (trim .Values.platform.license.value))) }}
{{- fail "platform.license.value must hold the license token alone, one line of the form ldl1.<kid>.<payload>.<signature>" }}
{{- end }}
{{- if not (has .Values.tls.mode (list "generated" "secrets")) }}
{{- fail (printf "tls.mode must be generated or secrets, not %q" .Values.tls.mode) }}
{{- end }}
{{- if eq .Values.tls.mode "secrets" }}
{{- range $endpoint := list "platform" "studio" }}
{{- if not (get $.Values.tls.secrets $endpoint) }}
{{- fail (printf "tls.mode secrets needs tls.secrets.%s, the TLS Secret of hosts.%s" $endpoint $endpoint) }}
{{- end }}
{{- end }}
{{- if and (include "libredb-platform.managedKeycloak" .) (not .Values.tls.secrets.auth) }}
{{- fail "tls.mode secrets with a managed Keycloak needs tls.secrets.auth, the TLS Secret of hosts.auth" }}
{{- end }}
{{- if not .Values.tls.caBundle }}
{{- fail "tls.mode secrets needs tls.caBundle, the PEM of the CA that issued the ingress certificates, which every pod trusts" }}
{{- end }}
{{- end }}
{{- if not (has .Values.postgresql.mode (list "managed" "external")) }}
{{- fail (printf "postgresql.mode must be managed or external, not %q" .Values.postgresql.mode) }}
{{- end }}
{{- if and (eq .Values.postgresql.mode "external") (not .Values.postgresql.external.host) }}
{{- fail "postgresql.mode external needs postgresql.external.host, the DNS name its certificate covers" }}
{{- end }}
{{- if not (has .Values.keycloak.mode (list "managed" "external")) }}
{{- fail (printf "keycloak.mode must be managed or external, not %q" .Values.keycloak.mode) }}
{{- end }}
{{- if eq .Values.keycloak.mode "external" }}
{{- $x := .Values.keycloak.external }}
{{- if not $x.baseUrl }}
{{- fail "keycloak.mode external needs keycloak.external.baseUrl" }}
{{- end }}
{{- if not (has $x.provisioning (list "installer" "manual")) }}
{{- fail (printf "keycloak.external.provisioning must be installer or manual, not %q" $x.provisioning) }}
{{- end }}
{{- if and (eq $x.provisioning "installer") (not $x.adminSecret) }}
{{- fail "keycloak.external.provisioning installer needs keycloak.external.adminSecret, the Secret with the admin credential" }}
{{- end }}
{{- if and (eq $x.provisioning "installer") (ne (len (compact (list $x.adminClientId $x.adminUser))) 1) }}
{{- fail "keycloak.external.provisioning installer needs exactly one of keycloak.external.adminClientId and keycloak.external.adminUser" }}
{{- end }}
{{- if and (eq $x.provisioning "manual") (not $x.clientSecretsSecret) }}
{{- fail "keycloak.external.provisioning manual needs keycloak.external.clientSecretsSecret, with the keys studio-client-secret and platform-client-secret" }}
{{- end }}
{{- end }}
{{- if and .Values.network.httpsProxy (regexMatch "(?i)^[a-z][a-z0-9+.-]*://[^/]*@" .Values.network.httpsProxy) }}
{{- fail "network.httpsProxy must not hold credentials: the installation document that holds it is a ConfigMap" }}
{{- end }}
{{- if .Values.studio.enabled }}
{{- $issuer := include "libredb-platform.issuer" . }}
{{- if ne .Values.studio.config.oidcIssuer $issuer }}
{{- fail (printf "studio.config.oidcIssuer must be %s, the issuer of hosts.auth and keycloak.realm, not %q" $issuer .Values.studio.config.oidcIssuer) }}
{{- end }}
{{- if ne (.Values.studio.fullnameOverride | toString) "libredb-studio" }}
{{- fail "studio.fullnameOverride must stay libredb-studio: the restart job of the chart names Studio's Deployment so" }}
{{- end }}
{{- if ne .Values.studio.secrets.existingSecret "libredb-studio-env" }}
{{- fail "studio.secrets.existingSecret must stay libredb-studio-env: the bootstrap job writes Studio's secrets there" }}
{{- end }}
{{- if .Values.studio.ingress.enabled }}
{{- $hosts := list }}
{{- range .Values.studio.ingress.hosts }}{{ $hosts = append $hosts .host }}{{ end }}
{{- if ne (toJson $hosts) (toJson (list .Values.hosts.studio)) }}
{{- fail (printf "studio.ingress.hosts must hold exactly one host, hosts.studio (%s)" .Values.hosts.studio) }}
{{- end }}
{{- $tlsSecret := ternary "libredb-tls-studio" .Values.tls.secrets.studio (eq .Values.tls.mode "generated") }}
{{- $tls := .Values.studio.ingress.tls | default list }}
{{- if or (ne (len $tls) 1) (ne (get (first $tls | default dict) "secretName" | default "") $tlsSecret) (ne (toJson (get (first $tls | default dict) "hosts" | default list)) (toJson (list .Values.hosts.studio))) }}
{{- fail (printf "studio.ingress.tls must hold one entry with secretName %s and hosts [%s]: the TLS Secret of hosts.studio under tls.mode %s" $tlsSecret .Values.hosts.studio .Values.tls.mode) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
