# libredb-installer

The installer for on-prem LibreDB: it installs Platform, Studio, Keycloak and PostgreSQL behind a Caddy edge with Docker on one x86_64 Linux host, and can reuse an existing Keycloak or PostgreSQL.
It is a standalone Bun package, compiled into one binary for x86_64 Linux, and it is not part of the Platform build, lint or tests.
The [Docker install guide](../docs/deploy/install-docker.md) takes a customer through a first install, and this page is the reference for every command and configuration field.

## Commands

Run these inside `installer/` with Bun 1.4.2.

| Command | Purpose |
| --- | --- |
| `bun install --frozen-lockfile` | Install the dependencies from `bun.lock` |
| `bun run typecheck` | TypeScript check |
| `bun run test` | Unit tests under `test/unit` |
| `bun run coverage:check` | Unit tests with coverage, then fail below 100% line coverage for any file under `src/` except `src/adapters`, `src/steps` and `src/cli` |
| `bun run test:int` | Integration tests under `test/integration` against a Docker host |
| `bun test test/integration/postgres` | Provisioning against PostgreSQL 14, 15, 16, 17 and 18 in containers, as a superuser and as a CREATEROLE CREATEDB admin, and against an external PostgreSQL 15 with a certificate from a test CA |
| `bun test test/integration/keycloak` | The managed Keycloak of the rendered compose file on a provisioned PostgreSQL, its access handover, the edge's auth site and the converge of the Keycloak objects of `keycloak-configure` with logins against them, the converge into a reused realm of an external Keycloak, and the check of a realm configured from the export with the two client secrets only |
| `bun run test:e2e` | End-to-end tests under `test/e2e`, as root on a disposable Linux host with Docker and the license file of `LIBREDB_E2E_LICENSE_FILE` |
| `bunx playwright test --config e2e/playwright.config.ts` | Browser specs under `e2e/`, the interop suite among them, against the installation the end-to-end tests leave |
| `bun run embed` | Fetch the pinned Studio chart, check its sha256 and write `generated/embedded.json` and `generated/libredb-studio-<version>.tgz` |
| `bun run build` | Run `embed`, then compile `dist/libredb-installer-linux-x64` with the release manifest and the chart embedded |
| `bun run release:check` | Check the contract versions of `release/release.config.json` against the previous release in `release/history/`, its Studio pin against Platform's `STUDIO_TAG`, and its Studio and Platform digests against the registry |
| `bun run release:record` | Record a cut release as `release/history/<version>.json`, after the history and contract checks of `release:check` |

## Release manifest

`release/release.config.json` pins one LibreDB release: its version, the images `platform`, `studio`, `keycloak`, `postgres` and `edge` (each with its version and sha256 digest), the Studio chart with its sha256, the minimum Docker Engine and Compose versions that `preflight` checks and a Kubernetes minimum that this build does not use, the flag `studio.logoutHintVerified`, the version `studio.reportedVersion` that the pinned Studio build reports, and the bridge contract versions that Platform publishes and Studio supports.
A version of the form `git:<sha>` is a build of that commit instead of a release.
A Studio chart pinned that way is built from the commit by `bun run embed`, which then needs `LIBREDB_STUDIO_REPO` set to a libredb-studio clone that holds the commit, and Helm to fetch the chart dependencies.
The build is deterministic, so the same commit always gives the pinned sha256.
A release of Studio reports its own version, which `studio.reportedVersion` must equal, while a Studio build of a commit reports the version of the commit's `package.json`, which the build injects and `studio.reportedVersion` records when the build is pinned.

`bun run release:check` requires the Platform and Studio of this release to share a contract version, Platform to publish a version the previous Studio supports, and Studio to support a version the previous Platform publishes, so either app of this release works with the other app of the previous release, as during an upgrade, which recreates Platform before Studio.
It also requires the pinned Studio version to equal Platform's `tests/fixtures/governance/STUDIO_TAG` without a leading `v`, the pinned chart to deploy that version, and the pinned Studio digest to be the one the registry reports for it, so a release ships the Studio build whose governance contract Platform's tests check.
It requires the pinned Platform digest to be the one the registry reports for the pinned Platform version as well, so the placeholder digest, or the digest of another build such as one of `main`, fails the release job before it builds the binary.
A chart built from a Studio commit deploys the image of that commit, a build of a commit `git:<sha>` is tagged `git-<sha>` in the registry, and `LIBREDB_RELEASE_REGISTRY` names a registry mirror to ask for both digests instead of the upstream repositories, such as `registry.example.com/libredb`.
Run `bun run release:check` and then `bun run release:record` when a release is cut, and commit the file it writes, because `release:record` repeats only the history and contract checks.
The Installer Release workflow stops before it builds unless its tag is `installer-v<version>` for the `version` of both `release/release.config.json` and `package.json`, and `release/history/<version>.json` equals `release/release.config.json` as JSON, so commit that file before you push the tag.
The Docker install does not read the embedded Studio chart; the release tooling keeps it pinned and checked for the Kubernetes mode of the next release.
The same workflow publishes the Helm chart `charts/libredb-platform`, whose `version` must equal the release, with the binary in the GitHub release, in the Helm repository index on the branch `gh-pages` (`https://libredb.org/libredb-platform/`) and at `oci://ghcr.io/libredb/charts/libredb-platform`, so bump the chart's `version` and its `artifacthub.io/changes` together with the release.

## Usage

The examples run the release binary `libredb-installer-linux-x64` from the directory it was downloaded to, as the [install guide](../docs/deploy/install-docker.md#download-and-verify-the-installer) describes; `bun run build` writes the same binary to `dist/`.
The first `apply` copies it to `/opt/libredb/bin/libredb-installer`, which takes the same commands.

```bash
./libredb-installer-linux-x64 version
./libredb-installer-linux-x64 validate -c libredb.yaml --set docker.systemdUnit=true
./libredb-installer-linux-x64 images list -c libredb.yaml
```

`version` prints the installer version, the release version and both contract version sets.
`images list` prints one image reference per line, each pinned by its sha256 digest, rewritten to `<images.registry>/<name>@sha256:<digest>` when the configuration sets a registry mirror.

`validate` reads `libredb.yaml` (`apiVersion: install.libredb.org/v1`, `kind: LibreDBInstallation`), applies each `--set path=value` after the file with the value parsed as a YAML scalar, and prints the configuration normalized with every default filled in.
Secrets are accepted only as `<key>Env` or `<key>File` references, so an inline value under a key ending in `Password`, `Secret`, `Passphrase` or `Key` is refused with its path.
A license token is accepted only through `platform.licenseFile`, so an inline value under `platform.license` is refused the same way, and so is a token written in place of the path.
`platform.licenseFile` is required in every mode, because every install needs a license file from LibreDB, the free license included, so `validate` and every other command that reads the configuration exit 2 without it.
`test/fixtures/configs/docker-minimal.yaml` is the smallest valid configuration.

## Docker install

Docker mode installs the Compose project `libredb` under `/opt/libredb` on one x86_64 Linux host with Docker Engine 28.0.0 or newer and the Compose v2 plugin 2.24.0 or newer, the minimums of the release manifest, except Docker Engine 28.2.0 through 28.3.2, which `preflight` refuses.
The Docker Engine minimum and that refused range keep the ports published to `127.0.0.1`, such as `keycloak.adminPort`, on the host: before 28.0.0, hosts on the same L2 segment can reach them, and from 28.2.0 to 28.3.2 a firewalld reload lets a host with a route to a Docker bridge network reach them (CVE-2025-54388).
The refused range lives in the preflight module instead of the release manifest, because a minimum cannot exclude it and still admit 28.0.x and 28.1.x, and its message names the advisory GHSA-x4rx-4gw3-53p4 and asks for 28.3.3 or newer, which fixes it.
The [Docker install guide](../docs/deploy/install-docker.md) lists every prerequisite of the host.
Run every command below as root.
This build applies only `mode: docker`: `preflight`, `plan`, `apply`, `verify` and `db-script` refuse any other mode with exit 2. On Kubernetes, the Helm chart `charts/libredb-platform` runs the installer's Kubernetes-mode logic in its jobs (`src/kubernetes/`, bundled by `bun run build:helm-jobs`), as [install-kubernetes.md](../docs/deploy/install-kubernetes.md) describes.
This build applies every `tls.mode` (`generated`, `provided` and `external`) and `postgres.mode` `managed` or `external`.
Keycloak is either managed, or the customer's own Keycloak with a realm the installer reuses (see External Keycloak below).

```bash
sudo ./libredb-installer-linux-x64 preflight -c libredb.yaml
sudo ./libredb-installer-linux-x64 plan -c libredb.yaml
sudo ./libredb-installer-linux-x64 apply -c libredb.yaml
sudo ./libredb-installer-linux-x64 apply -c libredb.yaml --renew-certificates
sudo ./libredb-installer-linux-x64 verify -c libredb.yaml --output json
sudo ./libredb-installer-linux-x64 status
```

`preflight` checks the host and installs nothing: Linux, root, the Docker Engine and Compose minimums of the release and the refused Docker Engine range, the host tools the installer runs (`ss` always, and `systemctl` with `docker.systemdUnit: true`), and free published ports, and the provided certificates or the upstream TLS proxy of the TLS modes below.
With an external Keycloak it checks that Keycloak too, and prints every warning before `Preflight passed`.
With an external PostgreSQL it also checks that server, as the section [External PostgreSQL](#external-postgresql) describes, and pulls the pinned PostgreSQL image for psql when the engine does not hold it.
`plan` prints what `apply` would change, or `No changes` when the host already matches the configuration.
`apply` prints the plan and asks for confirmation on a terminal.
Without a terminal it requires `--yes` and otherwise exits 2 before touching the host.
`--only <step,...>` runs only the named steps, still in graph order.
`--renew-certificates` re-issues every leaf certificate from the kept internal CA, as the yearly renewal timer does.
A full `apply`, without `--only`, ends with the steps `verify` and `report`, which change nothing: it runs every check of `verify`, prints the result of each, and exits 4 when a check fails.
The report then prints the three URLs, the CA bundle path, the license that the check `platform-license` found, the paths of the first admin's and the user manager's temporary password files, the next steps, every failed check with its cause and the warnings the steps recorded, and never a secret value.
`verify` runs every check of the installation and prints each check's result, or with `--output json` a document `{"checks": [...]}` that holds every check's `id`, `result` (`passed`, `warning` or `failed`) and `cause` (null when it passed), and the `detail` of a check that names what it found, such as the license of `platform-license`.
It exits 4 when a check fails; a warning, which only `admin-mfa` and `platform-license` report, leaves the exit code at 0, and the report of `apply` lists it with the warnings of the steps.
`status` prints each step's last result, who holds the run lock, the state and health of every container, and the expiry and days left of the internal CA and of every leaf certificate.

`apply` runs these steps in order, and each one plans nothing when the host already matches, so a second `apply` prints `No changes`:

| Step | What it converges |
| --- | --- |
| `preflight` | The host checks of `preflight` |
| `images` | Pulls every image of the project by digest, and the PostgreSQL image whose psql the installer runs, unless the engine already holds it |
| `secrets` | Generates each missing secret once in `/opt/libredb/secrets/secrets.json` (mode 0600), the PostgreSQL superuser password, one password per provisioned role, Platform's `AUTH_SECRET` and Studio's `JWT_SECRET` and `STORAGE_ENCRYPTION_KEY` among them, records its fingerprint in the state, issues the first seal key, and runs the seal key rotation of `bridge.sealKeys` (see [Operations](#operations)) |
| `tls` | The internal CA under `/opt/libredb/tls/ca` and, only in `tls.mode: generated`, a leaf per public hostname, or one leaf `edge` for the one host of the ports style, and for PostgreSQL, issued when missing, invalid or within 30 days of expiry, and every leaf with `--renew-certificates`; the CA is never replaced; in `tls.mode: provided` the checked chain and key of each public hostname, copied to `/opt/libredb/tls/edge` |
| `base` | `/opt/libredb/{env,secrets,tls,ca,state,backups,logs,bin}` with their modes, the networks `libredb_edge` and `libredb_data` (internal with a managed PostgreSQL), the world-readable CA bundle `/opt/libredb/ca/ca.crt`, a copy of the running installer at `/opt/libredb/bin/libredb-installer`, the applied configuration at `/opt/libredb/libredb.yaml` (mode 0600), the enabled and started `libredb-tls-renew.timer` whenever the host runs systemd, or else a warning that nothing renews the certificates, and, with `docker.systemdUnit: true`, the enabled `libredb.service` |
| `edge-deploy` | The Caddy edge on port 443, or on the three ports of the ports style, or in `tls.mode: external` on `tls.external.httpPort`, with `/opt/libredb/compose.yaml` and `/opt/libredb/edge/Caddyfile` |
| `postgres-deploy` | The managed PostgreSQL on the internal network, with TLS, a `pg_hba.conf` that accepts only `hostssl` with SCRAM and its 0600 env file; a renewed server leaf or a changed `pg_hba.conf` is loaded with `SELECT pg_reload_conf()` without a restart; nothing with an external PostgreSQL |
| `postgres-provision` | The roles, databases, schema and role settings of Platform's PostgreSQL bootstrap ([`docker/postgres/bootstrap.psql`](../docker/postgres/bootstrap.psql)), database `keycloak` for a managed Keycloak and the backup role, then the privilege matrix and a LISTEN/NOTIFY round trip as `libredb_studio`; with an external PostgreSQL provisioned manually, only these checks as the app roles |
| `keycloak-deploy` | The managed Keycloak with its 0600 env file, healthy on `/health/ready`, and on the first run the access handover to `libredb-installer` |
| `keycloak-configure` | The realm settings of a managed Keycloak and the clients, client scope, roles and accounts listed below in the realm, converged through the Admin REST API, or with `provisioning: manual` a check of the realm the site configured |
| `platform-migrate` | Platform's migrate job with its 0600 env file, run once when the job has not succeeded yet, its image or env file changed, or the migration history is missing or holds a failed migration |
| `platform-deploy` | Platform on the networks `libredb_edge` and `libredb_data` with its 0600 env file, healthy on `/api/health/live` |
| `studio-deploy` | Studio on the networks `libredb_edge` and `libredb_data` with its 0600 env file and the keyring `/opt/libredb/secrets/studio-keyring.json` (mode 0400, owner uid 1001), healthy on `/api/ready` |

`endpoints.style` places the three endpoints.
The default, `hostnames`, gives Platform, Studio and Keycloak a hostname each under `endpoints.hosts`, all on port 443.
`ports` is for a site without DNS: Docker mode serves the three endpoints on the one host `endpoints.host`, each on its own TLS port under `endpoints.ports`, 443 for Platform, 8443 for Studio and 9443 for Keycloak by default.

```yaml
endpoints:
  style: ports
  host: lab.corp
  ports: {platform: 443, studio: 8443, auth: 9443}
```

The URLs keep every port other than 443, such as `https://lab.corp:8443` for Studio and the issuer `https://lab.corp:9443/realms/libredb`.
The CA issues one leaf for that host, the edge holds it as its one network alias, and the edge listens inside its container on the same port numbers it publishes, so a container that calls a public URL reaches the edge unchanged.
`validate` refuses the ports style with an external Keycloak, which serves its own host, and with two endpoints on one port, each with exit 2.
It also refuses the ports style with `tls.mode: provided` or `external`, because the one host gets one generated leaf, while those modes take a chain per endpoint or tell the sites apart by hostname.
The ports style is a documented downgrade from separate hostnames for sites where DNS is impossible: browsers scope cookies and HSTS by host and not by port, so Platform, Studio and Keycloak share them.
Each app's server therefore receives the cookies of the others, and script on one app can set cookies that the others read, so a compromise of one app reaches the sessions of the others.
Both apps use distinct cookie names, Platform naming its sidebar cookie `libredb_platform_sidebar_state` where Studio writes `sidebar_state`, which keeps them from overwriting each other's cookies but does not isolate them, and the report of `apply` repeats this warning.
`test/fixtures/configs/docker-ports.yaml` is the configuration of the ports end-to-end test.

In `tls.mode: generated` the internal CA, an ECDSA P-256 root kept for 10 years, issues every leaf for 825 days, never past its own expiry.
Every `apply` re-issues a leaf that is missing, invalid or within 30 days of expiry, and `apply --renew-certificates` re-issues every leaf while keeping the CA.
`libredb-tls-renew.timer` runs `/opt/libredb/bin/libredb-installer apply --renew-certificates --yes -c /opt/libredb/libredb.yaml` once a year, and also at the next boot after a missed run; `systemctl list-timers libredb-tls-renew.timer` shows its next run.
A host that does not run systemd, which has no `/run/systemd/system`, gets no timer, and `plan` and `apply` warn there with that command to run once a year instead.
The applied configuration keeps the `--set` overrides of the last `apply`, with every `*File` reference made absolute, so the timer applies what the operator applied.
The installer must run as the compiled binary for this: an `apply` from source fails in the `base` step, because there is no binary for the timer to run.
Compose labels make `docker compose up -d` recreate exactly the services that must reload changed trust: `org.libredb.ca-sha256`, the SHA-256 of the CA bundle, on `edge`, `keycloak`, `platform` and `studio`, because Node reads `NODE_EXTRA_CA_CERTS` and Keycloak its truststore only at start, and `org.libredb.tls-sha256`, the SHA-256 of the edge certificates, on `edge`.
Adding a `tls.caBundleFile` therefore recreates those four services and leaves PostgreSQL running.

`tls.mode: provided` serves the customer's certificates.
`tls.provided.<endpoint>.certificateFile` holds the chain of one endpoint, the leaf first and then its intermediates, and `keyFile` its unencrypted PEM private key, for `platform`, `studio` and, while the edge serves the managed Keycloak, `auth`.
One file pair may serve several endpoints, such as a wildcard certificate.
`tls.caBundleFile` is required and holds the CA that the chains validate against; it joins the CA bundle of the apps.
`preflight` and `apply` refuse with exit 3 a key that does not match its certificate, a host its certificate does not cover, an expired certificate and a chain that does not validate against `tls.caBundleFile`, and name every problem, such as `tls.provided: certificate does not cover platform.corp, auth.corp`.
The installer never renews a provided certificate: replace the files and run `apply`, which copies them to the edge and recreates it.

`tls.mode: external` puts the edge behind the customer's TLS proxy.
The edge serves plain HTTP on `tls.external.httpPort` (default 8080), one site per public hostname, and the upstream proxy terminates TLS on 443 of each public hostname and forwards to that port with `X-Forwarded-Proto` and `X-Forwarded-Host`.
The proxy must accept response headers of 16 KB: Platform's sign-in callback sets its session cookie in chunks, which hold the Keycloak ID and refresh tokens, beside the state and PKCE cookies it clears, more than the 4 KB that nginx buffers by default on x86_64, so an nginx with its defaults answers that callback 502 (`upstream sent too big header`) while every check of `verify` passes.
With nginx, such as the proxy of CapRover, set `proxy_buffer_size 16k;` and `proxy_buffers 8 16k;` in the location that forwards to the edge; Traefik, as Dokploy runs it, needs no setting.
`tls.external.trustedProxies` is required and has no default: it lists the upstream proxy's addresses as the edge sees them, as CIDR ranges such as `192.0.2.10/32`, and the edge passes `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on only from them, so `validate` refuses `tls.mode: external` without it with exit 2.
The edge sees a proxy on another host at that host's own address when no NAT lies between them, and a proxy container on the network `libredb_edge` at its address there, while a proxy on the Docker host that connects through `127.0.0.1` arrives from the gateway of `libredb_edge`, the address that containers of other networks arrive from as well when they connect to the published port.
Docker picks that gateway when the first `apply` creates the network, such as `172.19.0.1` on a host whose bridge networks hold `172.17.0.0/16` and `172.18.0.0/16`, as the default bridge and the `docker_gwbridge` of a Swarm such as Dokploy's or CapRover's do; `docker network inspect libredb_edge -f '{{(index .IPAM.Config 0).Gateway}}'` prints it, and when it differs from `trustedProxies`, `verify` fails `studio-oidc-chain` with a `redirect_uri` of `http://`, so correct the value and run `apply` again.
`private_ranges` is accepted when written out, but it trusts every client on a private network.
The edge's HTTP port must be reachable only from the upstream proxy, because a client that reaches it directly bypasses the proxy's TLS: restrict it with a host firewall rule, which with Docker's iptables backend belongs in the `DOCKER-USER` chain, because Docker forwards the traffic of a published port past the `INPUT` chain.
Match the host's external interface in that rule, such as `iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8080 -j DROP` for a proxy on the Docker host: Docker passes the traffic between containers through `DOCKER-USER` as well, so a rule on the port alone also drops Platform's and Studio's calls to Keycloak on its port 8080, and `verify` then fails `platform-admin-api`, `platform-signin-redirect`, `studio-oidc-chain` and `oidc-discovery-in-network`.
The edge then holds no hostname alias, so the containers reach the public issuer and app URLs through the upstream proxy: every public hostname must resolve from inside the network `libredb_edge` to the proxy, and the proxy must present a certificate for it that validates against `tls.caBundleFile`, which is required.
`preflight` checks both from a one-shot container of the Platform image on `libredb_edge`, or on Docker's default bridge before the first `apply` has created that network, and refuses with exit 3 naming each host that does not resolve or present a valid chain.
`verify`'s `edge-tls` then connects to each public hostname on 443 by its name, through the upstream proxy.

#### Beside Dokploy or CapRover

Dokploy and CapRover hold ports 80 and 443 of their host, where `preflight` refuses the default `tls.mode: generated` with exit 3 naming their proxy container, so LibreDB installs on such a host in `tls.mode: external` behind their proxy:

- Dokploy: a file under `/etc/dokploy/traefik/dynamic` with an HTTP router for the three hostnames on entry point `websecure`, `tls: {}`, the site's certificate in a `tls.certificates` entry, and a service to `http://<host address>:8080`.
- CapRover: an app with the three hostnames as custom domains whose custom nginx configuration listens on 443 with the site's certificate, which CapRover's own HTTPS gives only from Let's Encrypt, proxies to `http://<host address>:8080` and sets `proxy_buffer_size 16k;` and `proxy_buffers 8 16k;`.
- `trustedProxies` holds the gateway of `libredb_edge`, which both proxies arrive from.

Both clean up Docker on their own, which removes the containers of a LibreDB service that is stopped at that moment, such as Studio after the kill switch of [break-glass.md](docs/runbooks/break-glass.md) or the apps during a [restore](docs/runbooks/restore.md): Dokploy's daily Docker cleanup, on by default, runs `docker container prune`, `docker image prune --all` and `docker system prune --all`, and CapRover runs `docker container prune` after every deploy of one of its apps.
`docker compose up -d` and `apply` create such a container again, with its volume.
Dokploy's cleanup of unused volumes (`docker volume prune --all`), which its daily cleanup leaves out, also deletes the volume of a removed container, such as `libredb_platform-uploads` with every support attachment, so never run it while a LibreDB service is stopped.

The managed PostgreSQL leaf comes from the internal CA in every TLS mode.
`tls export-ca [-o <file> [--force]]` writes the internal CA certificate, without its key, for the trust stores of database clients and, in `tls.mode: generated`, of browsers:

```bash
sudo ./libredb-installer-linux-x64 tls export-ca -o ca.crt
```

It runs as root, and `-o` may name a path below a directory that another user can write to, such as `/tmp`, so it exits 2 on a path that another user could redirect, and names why.
The path must not contain a symbolic link, and the refusal names the path it resolves to, which can be passed instead.
Every directory of the path, from `/` down, must be owned by root, by the user that runs the installer or, when root runs it under `sudo`, by the operator who ran `sudo`, whose uid `SUDO_UID` holds, so a path below the operator's own home directory is accepted; another user's directory is refused.
A directory that its group or others can write to must have the sticky bit, as `/tmp` has, and the refusal of one without it names the `chmod`, such as `chmod g-w <dir>` for a directory that a umask of 002 left group-writable, or a path below a root-owned directory to name instead.
It creates the file by the resolved path with mode 0644 and exits 2 when the path already exists, unless `--force` is given.
`--force` writes a new file beside the path and renames it over the path, so it replaces a regular file or a symbolic link itself and never follows the link, and it never replaces a directory or any other kind of file.

`postgres-provision` runs psql in one-shot containers of the pinned PostgreSQL image on the network `libredb_data`, with `sslmode=verify-full` against the CA bundle.
The connection settings go through a 0600 env file under `/opt/libredb/env` that is deleted when psql exits, the password through the environment of the docker client, so no password touches the disk, and the script through standard input.
Every role password reaches the server as a SCRAM-SHA-256 verifier with a fresh salt, so no cleartext password reaches it or its logs.
The step first checks the server: PostgreSQL 15 or newer, not a standby, an admin role with SUPERUSER, or CREATEROLE and CREATEDB, and `max_connections` at least the [connection budget](../docs/deploy/platform-runtime.md#connection-budget) of Platform's runtime page, which is 62 for one replica of each app with a managed Keycloak, because a Platform replica holds 14 connections.
A failed check exits 3, and so does a role or database of LibreDB's names that exists but that the state does not record as created by this installation.
A role whose login with its stored password fails gets its password set again, so a converged server plans nothing and an unchanged re-run executes no statement.
A drifted role gets back only the attributes that drifted, so an admin role with CREATEROLE but without SUPERUSER repairs it as well.
`libredb_backup` (member of `pg_read_all_data`, with CONNECT on `libredb` and `keycloak`) is created when the admin role is a superuser or holds `pg_read_all_data` WITH ADMIN OPTION; otherwise `apply` prints a warning.
After provisioning, every row of the privilege matrix must be true, or the step exits 4 naming the false rows, and `verify` runs the same matrix as the check `postgres-privileges`.

`keycloak-deploy` runs `quay.io/keycloak/keycloak` pinned by digest with `start`, one replica on the networks `libredb_edge` and `libredb_data`, against database `keycloak` as `libredb_keycloak` over JDBC with `sslmode=verify-full` against the CA bundle, and with a pool of at most 20 connections.
`KC_HOSTNAME` is the public auth URL, and the edge forwards only `/realms/<realm>/*` and `/resources/*` of the auth hostname to Keycloak and answers 404 for every other path, so the admin console and realm `master` stay internal.
Before that match, the edge answers 400 to a request whose raw path, without the query, contains `..`, `;`, a backslash, or a percent-encoded dot, slash or backslash, because Caddy and Keycloak could resolve such a path two ways.
Keycloak's port 8080 is published only on `127.0.0.1:<keycloak.adminPort>` (default 18080), which is also `KC_HOSTNAME_ADMIN`, and the installer reaches the Admin API only through it.
`/opt/libredb/env/keycloak.env` (mode 0600) holds `KC_DB_PASSWORD`, and on the first start the temporary bootstrap client `libredb-bootstrap` with a generated secret.
`apply` waits until Keycloak is healthy, then hands access over once: with the bootstrap client it creates the realm (attribute `libredb.managed=true`, registration off, and the realm settings of the table below) and the service client `libredb-installer`, whose service account holds the `realm-management` role `realm-admin`.
It writes that client's secret to `/opt/libredb/secrets/installer.env` (mode 0600, owner root, mounted in no container), proves a token as `libredb-installer`, deletes `libredb-bootstrap` from realm `master` and removes the bootstrap variables from `keycloak.env`.
Every later run authenticates only as `libredb-installer` at `/realms/<realm>/protocol/openid-connect/token` and only reads the Admin API, and the run log records the method, path and status of each request but never a token.
A handover that stopped halfway resumes on the next `apply`.
A realm or a `libredb-installer` client of the same name without `libredb.managed=true` stops the step with exit 6.
When neither the bootstrap client nor the secret in `installer.env` is accepted, the step fails with exit 1 and names the file to restore.

`keycloak-configure` converges the realm through the Admin REST API as `libredb-installer`, never by a realm import, and plans each change as one request:

| Object | What the installer keeps |
| --- | --- |
| Realm settings, with a managed Keycloak only | Brute force detection, which makes an account wait 1 minute after 5 failed sign-ins and a minute more after every further 5, up to 15 minutes, and 1 minute after two failures less than a second apart, resets the count 12 hours after the last failure, and disables an account after more than 100 wrong OTP codes that followed its correct password, until the user manager unlocks it as the [Keycloak roles runbook](docs/runbooks/keycloak-roles.md#lift-a-lockout) describes; the password policy `length(15) and notUsername and notEmail and passwordHistory(3)`; and saved login and admin events, which expire after 90 days, each admin event with the representation of its change, which names the role a mapping grants and from which Keycloak strips passwords and client secrets; a reused realm keeps its own settings |
| Client `libredb` | Role holder only: confidential, every flow off, with the client roles `admin` and `user` |
| Client scope `libredb-roles` | `include.in.token.scope=false`, exactly one mapper `oidc-usermodel-client-role-mapper` that writes the `libredb` client roles into the claim `libredb_roles` of the ID token, access token, userinfo and introspection, and scope mappings for `libredb:admin` and `libredb:user` |
| Clients `libredb-studio` and `libredb-platform` | Confidential with the standard flow only, PKCE S256, the redirect URI `https://<studio>/api/auth/oidc/callback` or `https://<platform>/api/auth/callback/keycloak` and the post-logout URI `https://<studio>/login` or `https://<platform>/login`, the realm's default client scopes plus `libredb-roles`, and the client secret from the secret store |
| Client `libredb-mobile`, only with `mobile.enabled: true` | Public with the standard flow only, PKCE S256, no direct access grants and no implicit flow, the redirect and post-logout URIs of `mobile.redirectUri` and `mobile.postLogoutRedirectUri`, the default client scopes `basic`, `profile`, `email` and `libredb-roles` besides the realm's, and the client's own mappers `oidc-audience-mapper` that add the audiences `libredb-studio-api` and `libredb-platform-api` to the access token only (see [Mobile app](#mobile-app)) |
| Service account of `libredb-platform` | Exactly the `realm-management` roles `view-users` and `view-clients`, which are also in the client's scope mappings so that the directory stays readable when Full Scope Allowed is off |
| First admin (`keycloak.firstAdmin.username`, default `libredb-admin`) | Created once with `libredb:admin`, no `realm-management` role, a temporary password in `/opt/libredb/secrets/first-admin.txt` and the required actions `UPDATE_PASSWORD` and `CONFIGURE_TOTP` |
| User manager (`keycloak.userManager.username`, default `libredb-user-manager`) | Created once while `keycloak.userManager.enabled` is true, the default for a managed Keycloak, with exactly the `realm-management` roles `manage-users`, `view-users`, `query-groups` and `view-clients`, no `libredb` role, a temporary password in `/opt/libredb/secrets/user-manager.txt` and the same required actions |

The user manager creates users and assigns them `libredb:admin` or `libredb:user` in the realm console that `keycloak console` opens, and the first admin signs in to Platform.
They are two accounts, because an account that can manage users can give `libredb:admin` to anyone.
Both usernames must be lowercase, the form Keycloak stores, and `validate` refuses one account as both.
Both password files are 0600 and owned by root, each written before its account exists, and an existing account's password is never reset.
Keycloak 26 asks both accounts for a new password, which the realm's password policy checks, a TOTP device, an email and their names at the first login.
An update sends the realm, the client or the client scope as Keycloak holds it with the installer's fields put over it, so a setting the installer does not own, such as Full Scope Allowed, keeps the value an operator gave it in the console.
A realm setting of the table that someone changed in the console is planned as `update realm <realm> (<fields>)` and set back on the next `apply`, the unattended `apply` of the renewal timer included.
The step changes the settings of a managed Keycloak's realm only while the realm carries `libredb.managed=true`, and a realm without it stops the step with exit 6.
A client secret regenerated in the console converges back to the stored one, and a role taken from or given to either account converges back too.
Every client, client scope and role the installer creates carries the attribute `libredb.managed=true`, and the state records every account it created, because Keycloak 26 drops user attributes that its user profile does not declare.
An object of the same name without that marker stops the step with exit 6 naming it, and so does an existing user of an account's name that the state does not record.
An account the state records stays deleted after someone deleted it in the console.
A pairwise subject mapper (`oidc-sha256-pairwise-sub-mapper`) on either app client stops the step with exit 3, because it would change the `sub` claim that both apps key users by.
The client secrets are generated once by the `secrets` step as `keycloak-client-libredb-studio` and `keycloak-client-libredb-platform`.

```bash
./libredb-installer-linux-x64 keycloak console -c libredb.yaml
```

`keycloak console` prints the realm console URL `http://127.0.0.1:<keycloak.adminPort>/admin/<realm>/console/` and the SSH tunnel command (`ssh -N -L <port>:127.0.0.1:<port> <user>@<host>`) that reaches it from a remote workstation.

### External Keycloak

With `keycloak.mode: external` the installer deploys no Keycloak and reuses an existing realm of the customer's Keycloak.
It never creates the realm, never changes the realm's settings and never imports a realm, and it creates no `libredb-installer` client there.
`keycloak-configure` converges the objects of the table above in that realm through the Admin API, exactly as for a managed Keycloak, and an object of the same name without `libredb.managed=true` stops the step with exit 6.

```yaml
endpoints:
  hosts:
    platform: libredb.corp.example
    studio: studio.corp.example
    auth: sso.corp.example
keycloak:
  mode: external
  realm: corp
  external:
    baseUrl: https://sso.corp.example
    adminRealm: master
    adminUser: admin
    adminPasswordEnv: CORP_KEYCLOAK_ADMIN_PASSWORD
    caBundleFile: /etc/pki/corp-ca.pem
```

| Field | Meaning |
| --- | --- |
| `keycloak.realm` | The realm to reuse, which must exist |
| `keycloak.external.baseUrl` | The https URL Keycloak announces, with a path such as `/auth` when it serves one; the issuer is `<baseUrl>/realms/<realm>`, and its host must equal `endpoints.hosts.auth` |
| `keycloak.external.adminUrl` | Optional: where the site serves the Admin API apart from the public URL; the installer calls it, Platform receives it as `KEYCLOAK_ADMIN_URL`, and `NO_PROXY` lists its host |
| `keycloak.external.adminRealm` | The realm of the admin credential, `master` by default |
| `adminClientId` with `adminClientSecretEnv` or `adminClientSecretFile` | A confidential client with service accounts whose service account may administer the realm, such as with `realm-management` `realm-admin` |
| `adminUser` with `adminPasswordEnv` or `adminPasswordFile` | A user of `adminRealm` who may administer the realm, signing in through `admin-cli` |
| `keycloak.external.caBundleFile` | Optional: the CA of a private issuer, which the CA bundle adds for both apps and which the installer trusts besides the system roots |

Exactly one admin credential is configured, and its secret only through its `Env` or `File` reference.
The installer reads it on each run that needs it, registers it with the redactor and never writes it to the state, an env file or the run log.
A secret file's last line break is not part of the secret.
Without `keycloak.external.adminUrl`, `platform.env` has no `KEYCLOAK_ADMIN_URL`, and Platform derives the Admin API URL from the issuer.

`preflight` refuses with exit 3 an issuer it cannot reach over TLS while trusting the system roots and `caBundleFile`, a discovery document that names another issuer, an admin credential that Keycloak refuses, a realm that does not exist, a Keycloak older than 25 (the client role mapper of `libredb-roles` sets the introspection flag that Keycloak 25 added), a pairwise subject mapper on `libredb-studio` or `libredb-platform`, and a Keycloak clock more than 15 s away from the installer's.
It warns on a Keycloak 25, which is untested, and on a realm whose SSO Session Idle is not longer than Platform's session recheck of 300 s, because the realm's settings stay the site's and Platform's refresh would then come too late.

In a reused realm the first admin and the user manager are off unless `keycloak.firstAdmin.enabled` or `keycloak.userManager.enabled` is set, because the customer's identity team manages the realm's users.
So unless `keycloak.userManager.enabled` is set, no human account gets a `realm-management` role from the installer, and only the service account of `libredb-platform` holds `view-users` and `view-clients`, which Platform's directory needs.
The identity team gives each LibreDB user the role `admin` or `user` of client `libredb`, directly or through a group.
`libredb-platform` keeps Use refresh tokens on (`use.refresh.tokens=true`) in every realm, because Platform refuses a sign-in without a refresh token.

A run without the admin credential, such as the unattended apply of a renewal timer, skips the Keycloak checks of `preflight` and the `keycloak-configure` step with a warning while the step's inputs are unchanged since it last converged the realm.
When they changed, such a run stops with exit 2 and names the reference that is not set.
`verify` needs no admin credential: it reads Keycloak's clock from a `libredb-platform` token, and `admin-mfa` reads the realm's role holders and their credentials with the `view-users` and `view-clients` of that client's service account.
`keycloak console` exits 2 for an external Keycloak, whose own console the site opens.

### A realm the site configures itself

With `keycloak.external.provisioning: manual` the site's identity team configures the realm from the installer's export and shares only the secrets of `libredb-studio` and `libredb-platform`.
The installer then takes no Keycloak admin credential at all: `adminRealm`, `adminClientId`, `adminUser` and their references are refused, and so are `keycloak.firstAdmin.enabled` and `keycloak.userManager.enabled`, because the site creates its users.

```yaml
keycloak:
  mode: external
  realm: corp
  external:
    baseUrl: https://sso.corp.example
    provisioning: manual
    studioClientSecretFile: /root/libredb-studio-client-secret
    platformClientSecretFile: /root/libredb-platform-client-secret
    caBundleFile: /etc/pki/corp-ca.pem
```

```bash
./libredb-installer-linux-x64 keycloak export -c libredb.yaml -o keycloak-export
```

`keycloak export` writes `keycloak-export/libredb-keycloak-export.json`: the realm, the issuer and the Admin REST requests the installer itself would send to an empty realm, in order, with placeholders such as `(client.libredb)` for the ids Keycloak assigns.
They create client `libredb` with the roles `admin` and `user`, client scope `libredb-roles` with its mapper and scope mappings, `libredb-studio` and `libredb-platform` with their redirect and post-logout URIs and the default scope `libredb-roles`, and the `realm-management` roles `view-users` and `view-clients` for the service account of `libredb-platform`.
With `mobile.enabled: true` they also create the public client `libredb-mobile` with its default scopes and its two audience mappers, after the app clients.
The export holds no secret and no user, needs no root and reads nothing from the host or from Keycloak.
An operator may still run it as root, so the directory of `-o` must pass the rule of `tls export-ca -o`: no symbolic link in the path, and every directory from `/` down owned by root, by the user that runs the installer or by the operator who ran `sudo`, and writable by its owner only, unless it has the sticky bit; otherwise it exits 2 naming the problem.
It exits 2 when `-o` names something other than a directory, and creates a missing directory with mode 0755 only when its parent exists and passes the same rule; a missing parent exits 2 naming it, because the export creates no parent directory.
It writes the file with mode 0644 and exits 2 when the file already exists, unless `--force` is given, which replaces it the way `tls export-ca --force` does, never following a symbolic link.
`docs/keycloak-manual.md` gives the same configuration as admin console steps.

Each client secret is read through `studioClientSecretEnv` or `studioClientSecretFile` and `platformClientSecretEnv` or `platformClientSecretFile`, exactly one of each.
The `secrets` step stores a supplied secret that the store does not hold yet, and both apps receive the stored ones.
A run whose reference supplies nothing keeps the stored secret with a warning, and a first run without it stops with exit 2.

`preflight` checks the issuer's discovery document only, and `keycloak-configure` changes nothing in the realm and checks it from outside instead.
It refuses with exit 3, naming each finding, when discovery fails at the issuer, when token introspection refuses either client secret, when `libredb-platform` gets no token through `client_credentials`, when that token cannot list users (`view-users`) or read client `libredb` (`view-clients`), when client `libredb` lacks the role `admin` or `user`, and when an app client's redirect URIs, post-logout URI, PKCE method, client authentication, standard flow or default client scope `libredb-roles` differ from the export, `libredb-platform` has Use refresh tokens off, or an app client has a pairwise subject mapper.
With `mobile.enabled: true` it reads `libredb-mobile` as well, which shares no secret, and refuses it when it is missing, confidential, has the implicit flow or direct access grants on, lacks one of its default scopes or lacks one of the two mappers of type `oidc-audience-mapper` with the configuration of the export, or differs in the checks above.
The check runs on every apply, so a realm that the site changes later is refused on the next run.

Platform runs from the pinned Platform image in two services of `/opt/libredb/compose.yaml`.
`platform-migrate`, in the Compose profile `jobs` that `up` never starts, runs `migrate` with `/opt/libredb/env/platform-migrate.env`, the only file that holds `MIGRATE_DATABASE_URL`, on the network `libredb_data` alone.
`platform` runs `serve` with `/opt/libredb/env/platform.env`, which holds the runtime set that [`contracts/env-inventory.yaml`](contracts/env-inventory.yaml) lists for Platform, with `KEYCLOAK_ADMIN_URL=http://keycloak:8080` and `QUERY_LOG_RETENTION_DAYS=90`.
`PLATFORM_API_AUDIENCE=libredb-platform-api` and `PLATFORM_API_CLIENT_IDS=libredb-mobile` are written only with `mobile.enabled: true` (see [Mobile app](#mobile-app)).
It runs as uid 1001 with a read-only root filesystem, tmpfs for `/tmp` and `/app/.next/cache`, the volume `platform-uploads` at `/app/uploads`, no capabilities, `no-new-privileges` and the CA bundle read-only at `/etc/libredb/ca`.
`BRIDGE_SEAL_PUBLIC_KEY` is the public half of the oldest live seal key in the secret store, so a key issued later reaches Studio's keyring before Platform seals with it.
The env files quote a value that Compose would otherwise change, and a value that no quoting carries, one with a single quote together with `$`, `"` or `\`, stops the step naming the variable.

`platform-migrate` runs `docker compose -p libredb --profile jobs run --rm platform-migrate` before `platform-deploy` recreates anything.
A job that exits non-zero fails `apply` with exit 1 and the job log, and the run stops before `platform-deploy`, so the running Platform stays as it was.
When Prisma reports a failed migration (P3009, or P3018 for one that failed in this run), the error also prints the `migrate-status` and `migrate-resolve` commands that repair the history.
After a job that succeeded, the state records a revision that holds the latest applied migration of `platform._prisma_migrations`.
No command reads these revisions, and the installer supports neither a downgrade nor a rollback, as the [upgrade runbook](docs/runbooks/upgrade.md) says.

Studio runs from the pinned Studio image as the service `studio` of `/opt/libredb/compose.yaml`, with `/opt/libredb/env/studio.env`, which holds the governance set that `contracts/env-inventory.yaml` lists for Studio, such as `OIDC_ROLE_CLAIM=libredb_roles`, `GOVERNANCE_SOURCE=postgres` and `STORAGE_PROVIDER=postgres` with schema `studio`.
It runs as uid 1001 with a read-only root filesystem, tmpfs for `/tmp` and `/app/.next/cache`, the volume `studio-data` at `/app/data`, no capabilities, `no-new-privileges` and the CA bundle read-only at `/etc/libredb/ca`.
Its hostname and its `GOVERNANCE_INSTANCE_ID` are both `libredb-studio`, so a recreated container updates the same `bridge.studio_instance` row, because this release runs one Studio replica.
`studio-deploy` writes the keyring of the live seal keys to `/opt/libredb/secrets/studio-keyring.json` with mode 0400 and owner uid 1001, and only `studio` mounts it, read-only at `/etc/libredb/governance/keyring.json`.
The mount uses the long syntax without `create_host_path`, so a keyring missing on the host fails the start instead of becoming a directory there.
Studio reads its env file, its keyring and the CA bundle only at start, so a change to any of them recreates the container.
`OIDC_LOGOUT_HINT=true` is written only when the release manifest sets `studio.logoutHintVerified`, which a passing run of the interop suite's "logout hint" test allows; this release sets it.
`OIDC_BEARER_AUDIENCE=libredb-studio-api` and `OIDC_BEARER_CLIENT_IDS=libredb-mobile` are written only with `mobile.enabled: true` (see [Mobile app](#mobile-app)).
`apply` waits until `GET /api/ready` answers 200, which Studio does once it has loaded a governance snapshot of a contract it supports, and fails while Studio stays loading, misconfigured or incompatible.

`verify` checks Platform with seven more checks:

| Check | What passes |
| --- | --- |
| `platform-ready` | `GET http://platform:3000/api/health/ready` answers 200 from inside the network |
| `platform-signin-redirect` | The Auth.js sign-in for provider `keycloak`, posted with its CSRF token through the edge, answers 302 to the issuer's authorization endpoint for client `libredb-platform` with `redirect_uri=https://<platform>/api/auth/callback/keycloak` |
| `platform-admin-api` | A `libredb-platform` client-credentials token, requested as Platform requests it, gets 200 on the users of role `libredb:admin` and 403 on a user create |
| `bridge-contract` | As `libredb_studio`, the versions `bridge.contract` lists as current or deprecated equal the manifest's `platformPublishes` |
| `seal-canary-published` | `bridge.seal_canary_v1` holds the kid of `BRIDGE_SEAL_PUBLIC_KEY` within 30 s |
| `bridge-privileges` | After migration, `libredb_owner` owns schemas `platform` and `bridge` and `libredb_studio` owns `studio`, `libredb_studio` has no USAGE on schema `platform` and may insert query events but not select them, and `libredb_platform` has no UPDATE, DELETE or TRUNCATE on `bridge.query_event`, read with `has_schema_privilege` and `has_table_privilege` |
| `platform-license` | The license line that Platform logged within 5 minutes of its start names a valid license, which passes while it is active, warns from 30 days before its expiry and in its 14-day grace period, and fails once the grace period ended; a token Platform refuses fails naming its code, because Platform then adds no user, connection or admin until a valid license is installed; it warns that it did not check when Docker has dropped those lines from a long log |

The HTTP checks run node scripts in one-shot containers of the Platform image on the network `libredb_edge`, so they resolve and trust the names Platform does; the Admin API check runs with Platform's env file.

`verify` also checks the host, Studio and the sign-in chain:

| Check | What passes |
| --- | --- |
| `components-healthy` | Every running service of the compose file reports healthy, PostgreSQL through `pg_isready` and Keycloak through `:9000/health/ready` |
| `clock-skew` | The installer clock is within 15 s of PostgreSQL's `clock_timestamp()` and of Keycloak's clock, the `iat` of a token from its Admin API URL, because Keycloak 26 sends no `Date` header: a `libredb-installer` token on the loopback admin port, or a `libredb-platform` token from an external Keycloak |
| `no-proxy` | `NO_PROXY`, and `no_proxy` when set, of `platform.env` and `studio.env` hold every endpoint host, the host of `keycloak.external.adminUrl` when it is set, the PostgreSQL host, `.svc`, `.cluster.local`, `localhost` and `127.0.0.1` |
| `edge-tls` | Every public endpoint, connected to on its published port of the edge (443, or its port in the ports style), or in `tls.mode: external` on port 443 of the hostname itself through the upstream proxy, with its own server name, presents a chain that validates against the CA bundle, covers the hostname and has at least 30 days left; a failure names the host and the days left |
| `studio-ready` | `GET http://studio:3000/api/ready` answers 200 with status `ok` and `contract.active` equal to the highest version common to `platformPublishes` and `studioSupports`; a failure shows Studio's detail and points to `docker compose -p libredb logs studio` |
| `studio-heartbeat` | `bridge.studio_instances_v1`, read as `libredb_studio`, holds exactly one row seen in the last 2 minutes, `libredb-studio`, and its `last_seen_at` advances within 75 s, two and a half of Studio's 30 s heartbeat intervals, so one late or failed beat does not fail the check |
| `studio-canary` | Within 60 s, every live row lists the kid of the `BRIDGE_SEAL_PUBLIC_KEY` in `platform.env` in `keyring_kids`, reports its canary `ok`, and reports the manifest's `studioSupports` and `studio.reportedVersion`, the version the pinned Studio build reports |
| `bridge-notify-roundtrip` | After `NOTIFY libredb_bridge, '{"v":1,"kind":"settings"}'` as `libredb_studio`, every live row reports a newer `last_notification_at` within 75 s, because only Studio's next beat writes it |
| `studio-oidc-chain` | From the edge network, `GET https://<studio>/login` redirects to `/api/auth/oidc/login`, which answers 307 to the issuer's authorization endpoint for `libredb-studio` with Studio's callback as `redirect_uri` and no `prompt`, and that endpoint answers 200; a redirect to `/login?error=oidc_config`, `oidc_discovery` or `oidc_failed` is named as a configuration error, an issuer Studio cannot reach or trust, or a failure after discovery |
| `oidc-discovery-in-network` | The Platform and Studio images, each with its own env file and so its proxy settings, fetch `<issuer>/.well-known/openid-configuration` from the edge network and receive exactly the configured issuer |
| `admin-mfa` | A warning check: it warns naming every account without an OTP credential that holds `libredb:admin`, or the `realm-management` role `manage-users` or `realm-admin`, directly or through a group, leaving service accounts out, because every governance install requires Keycloak MFA for them; it reads the realm as `libredb-installer`, or as `libredb-platform` for an external Keycloak, and warns that it did not run when `installer.env` of a managed Keycloak is missing |

```bash
sudo ./libredb-installer-linux-x64 db-shell --as platform
sudo ./libredb-installer-linux-x64 db-shell --as platform -c 'SELECT current_user'
```

`db-shell --as platform` opens psql as `libredb_platform` in a one-shot container on the network `libredb_data`, for the [break-glass](docs/runbooks/break-glass.md) procedure, such as withdrawing a user's access while Keycloak is down.
It reads the installed compose file and the secret store, so it takes no configuration, and its run log keeps the statements of `-c`.
With `-c` it runs the SQL and prints the rows unaligned and without headers; without it psql runs on the terminal.

The state is kept in `/opt/libredb/state/state.json` (mode 0600), which holds names, hashes and fingerprints and never a secret value.
`/opt/libredb/state/lock` holds the pid and host of a running `apply`, and a second run exits 5 while it is held.
Every `preflight`, `plan`, `apply`, `verify` and `db-shell` writes a log to `/opt/libredb/logs/installer-<timestamp>.log`, redacted like everything the installer prints.

`test/fixtures/configs/docker.yaml` is the configuration of the Docker end-to-end tests, which `.github/workflows/installer-e2e.yml` runs as root on `ubuntu-24.04` for every pull request that touches `installer/` and nightly on `main`.
A variant of it gets a fixture of its own or applies `--set` overrides.
`LIBREDB_E2E_IMAGES_REGISTRY` sets `images.registry` for every run of the end-to-end tests, such as `registry.example.com/libredb` for images that exist only in a registry mirror.
`LIBREDB_E2E_LICENSE_FILE` is required: it names the license file that every install of the end-to-end tests names in `platform.licenseFile`, a license that the pinned Platform image verifies for `platform.libredb.test` and `lab.libredb.test`, with 1 admin seat and 3 user seats.
Without it, every file of `test/e2e` fails at load naming the variable.
`installer-e2e.yml` and `installer-nightly.yml` write the file from the repository secret `LIBREDB_E2E_LICENSE`, the CI license, and fail when the secret is empty, as it is for a pull request from a fork.
`test/e2e/docker-external-kc.test.ts` installs with `test/fixtures/configs/docker-external-kc.yaml` against a stand-in for the customer's Keycloak, which runs from the pinned Keycloak image at `https://auth.libredb.test:$LIBREDB_E2E_EXTERNAL_KEYCLOAK_PORT` (default 8443) with realm `corp`, joins the network `libredb_edge` under that name as the site's DNS would, and is removed with the install when the file ends.
The browser specs under `e2e/` then sign in through the installation those tests leave, `--project hostnames` after the tests of `docker.yaml` and `--project ports` after `test/e2e/docker-ports.test.ts`, which `installer-e2e.yml` runs last because it installs over the hostnames style: `LIBREDB_E2E_FIRST_ADMIN_PASSWORD_FILE` names a copy of the first admin's temporary password (default `/opt/libredb/secrets/first-admin.txt`), and `LIBREDB_E2E_HOST_ADDRESS` maps the `.test` hostnames, `lab.libredb.test` of the ports style among them, to the address of another host that holds the installation.
`--project hostnames` first runs `e2e/platform-login.spec.ts`, the first admin's first login, as the project `first-login` it depends on, and every other spec of that style then signs in to Platform as the first admin, because the license of the end-to-end tests has one admin seat; `--no-deps` skips that first login against an installation whose first admin already signed in.
Chromium fails the requests in flight with `ERR_NETWORK_CHANGED` whenever an address of its host changes, and on the host of the installation every container start adds an IPv6 link-local address to the host's end of the container's veth, about 1.6 s later, and every stop removes it, so a host that runs the browser specs and the installation sets `sysctl -w net.ipv6.conf.default.addr_gen_mode=1` before the install, as both workflows do.
`e2e/interop.spec.ts`, the interop suite of the grant, query and revocation flows in `--project hostnames`, starts a target PostgreSQL container, `libredb-e2e-target`, on the network `libredb_edge` with a SELECT-only role and a read-write role, creates two users holding `libredb:user` through the Admin API as `libredb-installer` from a one-shot container of the Platform image, and removes them and the connection it creates at the end.
Every browser spec deletes the connections it creates when it ends, because the seal key drill of `e2e/runbooks.spec.ts` expects its own connection to be the only one sealed to the key it retires.
`LIBREDB_E2E_DOCKER` names the docker command those fixtures run (default `docker`), such as `docker exec <host> docker` for a Docker-in-Docker host.
The suite prints the measured revocation and session revocation latencies, each from the response of Platform's action with Studio polled every 100 ms.
`e2e/runbooks.spec.ts`, the operations drill in `--project hostnames`, runs every fenced shell block of the seal key, installer client and break-glass runbooks as written, as root on the install host through the command prefix `LIBREDB_E2E_ROOT` (default `sudo`, such as `docker exec -i <host>` for a Docker-in-Docker host), with `LIBREDB_CONFIG` pointing at a copy of the applied configuration that it edits between the blocks; it rotates the seal key and the `libredb-installer` secret of the installation it runs against.
The same workflow runs the PostgreSQL integration tests, which start one server per major version on a private Docker network and publish no host port.
`LIBREDB_IT_PREFIX` names their containers, network and scratch directory (default `libredb-it-pg`), and `LIBREDB_IT_POSTGRES_REPOSITORY` the server images, tagged by major version (default `docker.io/library/postgres`).
The external PostgreSQL test in `test/integration/postgres/external-tls.test.ts` takes both as well, with the default prefix `libredb-it-ext`.
`test/e2e/docker-external-pg.test.ts` installs against an external server, the release's PostgreSQL image with a certificate from a test CA for `pg.libredb.test`, which is its alias on the network `libredb_data` that the test creates before the first apply, so every container resolves it as a site's DNS would.
The Keycloak integration tests use the pinned release images, take `LIBREDB_IT_PREFIX` as well (default `libredb-it-kc`, with the infix `-cfg` for the converge test and `-reuse` for the reused realm), and publish Keycloak on `127.0.0.1:$LIBREDB_IT_KEYCLOAK_PORT` (default 18080) and the edge on `127.0.0.1:$LIBREDB_IT_EDGE_PORT` (default 18443).
The reused realm test runs the Keycloak image in dev mode with TLS from a test CA as the customer's Keycloak, and its HTTPS port is the one published there.
The contract drift tests in `test/integration/contracts` boot the pinned Platform and Studio images with the rendered env files on a private Docker network without host ports, take `LIBREDB_IT_PREFIX` (default `libredb-it-drift`), and pull the two app images from the registry mirror `LIBREDB_IT_APP_REGISTRY` when it is set.

### Mobile app

The LibreDB mobile app signs in to Keycloak itself, as a public client with the authorization code flow and PKCE S256, and calls Studio's API and Platform's API under `/api/v1` with `Authorization: Bearer <access token>`.
It is off unless the configuration enables it:

```yaml
mobile:
  enabled: true
  redirectUri: org.libredb.mobile:/oauth2redirect
  postLogoutRedirectUri: org.libredb.mobile:/oauth2redirect
```

| Field | Meaning |
| --- | --- |
| `mobile.enabled` | Required in the section: `true` creates client `libredb-mobile` and turns Studio's bearer channel and Platform's bearer API on for it |
| `mobile.redirectUri` | The app's redirect URI, `org.libredb.mobile:/oauth2redirect` by default |
| `mobile.postLogoutRedirectUri` | The app's post-logout redirect URI, `org.libredb.mobile:/oauth2redirect` by default |

`validate` accepts as a URI only a private-use scheme in reverse domain name form, such as `org.libredb.mobile:`, or an `https://` URL, each without a wildcard or a fragment, and refuses a scheme without a dot such as `libredb:`, which another app could claim as well.
`keycloak-configure` then creates `libredb-mobile` as the table above lists it, in a managed Keycloak and in a reused realm alike, and with `provisioning: manual` the export holds it and the check reads it.
Its access token carries the audience `libredb-studio-api` from the client's own audience mapper, which differs from `libredb-studio`, the audience of every ID token of Studio's web sign-in, because Studio refuses an ID token as a bearer.
A second audience mapper adds `libredb-platform-api` to the same access token, because Keycloak's audience mapper adds one custom audience, so one token serves both apps.
The claim `libredb_roles` reaches its ID token, from which the app reads its role, and its access token, from which Studio reads the role, through `libredb-roles`, which writes both tokens, and `basic`, `profile` and `email` put `sub`, `preferred_username` and `email` into the access token.
`studio.env` gets `OIDC_BEARER_AUDIENCE=libredb-studio-api` and `OIDC_BEARER_CLIENT_IDS=libredb-mobile`, so Studio accepts an access token only when its `aud` holds that audience and its `azp` is `libredb-mobile`.
Under governance Studio applies to that token the same sign-in rule as to a session cookie, and because the realm is the one Studio's web sign-in uses, its `sub` matches the subject of Platform's grants.
The bearer channel needs a Studio release that contains [libredb-studio#1914](https://github.com/libredb/libredb-studio/pull/1914); a Studio without it ignores both variables and the `Authorization` header, so the app gets `401` on every call.
This release pins Studio 1.0.0, which does not contain it.
`platform.env` gets `PLATFORM_API_AUDIENCE=libredb-platform-api` and `PLATFORM_API_CLIENT_IDS=libredb-mobile`, so Platform's API accepts an access token only when its `aud` holds that audience and its `azp` is `libredb-mobile`, and only for an account with the role `admin`, as [docs/api/v1.md](../docs/api/v1.md) describes.
The bearer API needs a Platform release that contains [#24](https://github.com/libredb/libredb-platform/issues/24); a Platform without it ignores both variables, so every call under `/api/v1` gets `404`.
This release pins Platform 1.0.1, which does not contain it.
Turning the mobile app off again removes the variables from `studio.env` and `platform.env`, and leaves `libredb-mobile` in the realm, where an administrator deletes it in the console.

| Exit code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Runtime failure |
| 2 | Invalid usage or invalid configuration |
| 3 | Preflight failed |
| 4 | Verification failed |
| 5 | Lock held |
| 6 | Unsafe change refused |

## External PostgreSQL

`postgres.mode: external` installs against a PostgreSQL server that the site already runs, such as a managed database service, instead of deploying one.
The server runs PostgreSQL 15 or newer, is the primary, accepts TLS, and has a `max_connections` that covers the connection budget.

```yaml
postgres:
  mode: external
  external:
    host: pg.corp.example
    port: 5432
    adminUser: corp_dba
    adminPasswordEnv: LIBREDB_PG_ADMIN_PASSWORD
    caBundleFile: /etc/pki/corp-db-ca.pem
    provisioning: installer
```

`host` is a DNS hostname that the server certificate covers, `port` defaults to 5432, and `provisioning` defaults to `installer`.
An IP address is refused, because the PostgreSQL client of Platform and Studio verifies a certificate against `localhost` instead of an IP address, so `sslmode=verify-full` would fail there.
`caBundleFile` holds the CA that issued the server certificate as its first certificate, and leads the CA bundle that every app and Keycloak trust.
It leads, because Platform's migrate job hands the bundle to Prisma as `sslcert`, and Prisma trusts only the first certificate of that file.
Every app URL and Keycloak's JDBC URL use `sslmode=verify-full` with that bundle.
The installation runs no `postgres` service, and the network `libredb_data` is not internal, so the apps, the migrate job and psql reach the server through it.
`compose.yaml` records the server and the psql image under the extension field `x-libredb`, which Compose ignores and `db-shell` reads.
The installer generates the role passwords as for a managed server, and keeps no superuser password.

With `provisioning: installer`, `apply` provisions the server as `adminUser`, a superuser or a role with CREATEROLE and CREATEDB that logs in to its database `postgres`.
It creates the roles, databases and settings of Platform's PostgreSQL bootstrap, database `keycloak` and role `libredb_keycloak` for a managed Keycloak, and `libredb_backup` when the admin role may grant `pg_read_all_data`.
The admin password comes from the variable that `adminPasswordEnv` names or the file that `adminPasswordFile` names, or else, on a terminal, from a prompt with masked entry.
It is read on each run that needs it, registered with the redactor, and never written to the state, an env file, the secret store or a log.
`sudo` drops the environment, so pass the variable through it:

```bash
sudo --preserve-env=LIBREDB_PG_ADMIN_PASSWORD ./libredb-installer-linux-x64 apply -c libredb.yaml --yes
```

`preflight` checks the server as `adminUser`: PostgreSQL 15 or newer, not a standby, SUPERUSER or CREATEROLE and CREATEDB, the connection budget, TLS with `sslmode=verify-full` against the first certificate of `caBundleFile` alone, which every client of the installation trusts, and a clock within 15 s of the installer's.
Without `caBundleFile` it exits 3 naming the setting.
Its psql runs on the network `libredb_data` once `base` created it, and before that on Docker's default bridge network, with that certificate in a temporary directory that it removes afterwards.
When the inputs of `preflight` or `postgres-provision` are unchanged since the step last succeeded and no admin password is supplied, the step skips what needs the admin role and records a warning that says so, so an unattended `apply --yes`, such as the certificate renewal timer, keeps working.
When the inputs changed and no admin password is supplied, a run without a terminal exits 2 naming the variable or the file to set.

With `provisioning: manual`, a DBA provisions the server and the installer holds no admin credential, so `adminUser`, `adminPasswordEnv` and `adminPasswordFile` are refused.

```bash
sudo ./libredb-installer-linux-x64 db-script -c libredb.yaml -o provision.sql
```

`db-script` generates the role passwords in the secret store once and writes `provision.sql` with mode 0600: the provisioning script of Platform's PostgreSQL bootstrap with a SCRAM-SHA-256 verifier of each password, and never a cleartext one.
It writes the file under the rules of `tls export-ca -o`, so it exits 2 when the file already exists, unless `--force` replaces it.
The DBA runs it once with psql as a superuser or as a role with CREATEROLE and CREATEDB, such as `psql "host=pg.corp.example dbname=postgres user=<admin> sslmode=verify-full sslrootcert=<CA file>" -f provision.sql`.
Running it again converges the server and sets the password of every app role to the stored one again.
`preflight` then checks the server as `libredb_platform`, without the attribute check.
`postgres-provision` checks that every role logs in with its stored password, the server checks, the privilege matrix as an app role reads it, and a LISTEN/NOTIFY round trip as `libredb_studio`, and exits 3 naming every problem and how to have the DBA run the script again.

`verify` reads the privilege matrix, the PostgreSQL clock and the bridge privileges as `libredb_platform` on an external server, because the installer keeps no admin credential, and counts the rows of the backup role when that role exists.

## Operations

`docs/runbooks/` holds the operations runbooks for a Docker install: [seal key rotation](docs/runbooks/seal-key-rotation.md), [secret rotation](docs/runbooks/secret-rotation.md) (Studio's `JWT_SECRET`, Platform's `AUTH_SECRET`, the Keycloak client secrets and the PostgreSQL role passwords), the [`libredb-installer` client](docs/runbooks/installer-client.md), [break-glass](docs/runbooks/break-glass.md), [backup and restore](docs/runbooks/restore.md), [Keycloak roles, realm settings and lockouts](docs/runbooks/keycloak-roles.md) and the [upgrade](docs/runbooks/upgrade.md) to a later release.
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) is the acceptance checklist of an installation: an on-site procedure and a sign-off line for each requirement R1 to R11 it defines, for the required hardening and for the Keycloak management roles.
Every rotation is additive, because a rollback cannot restore an old secret value.
A generated secret is regenerated by deleting it from `/opt/libredb/secrets/secrets.json` and running `apply`.

Three configuration fields drive the [seal key rotation](docs/runbooks/seal-key-rotation.md):

```yaml
bridge:
  sealKeys:
    issueNew: true              # add one live key to Studio's keyring while the active key is the newest live key
    activeKid: 0123456789abcdef # the key whose public half Platform receives; the oldest live key when absent
    retire: [fedcba9876543210]  # remove kids from the live keyring; the secret store keeps them in escrow
```

`apply` refuses with exit 6 to issue a key when the live keyring already holds 16 kids, to retire the active kid or a kid the store never issued, to make a retired or unknown kid active, and to retire a kid that an envelope in `bridge.connections_v1` still uses, naming those connections.
Retiring a kid also deletes its row from `platform.seal_canary` as `libredb_platform` in the same `apply`, because Platform only inserts canaries.

`platform.authSecretPreviousFile` names a file that holds the previous `AUTH_SECRET`, which `apply` writes as `AUTH_SECRET_PREVIOUS` in `platform.env` for the rotation window of the [secret rotation](docs/runbooks/secret-rotation.md) runbook; a missing or empty file exits 2, and so does a symbolic link or a directory at the path.

`platform.licenseFile` names a file that holds the license token, which `apply` writes as `PLATFORM_LICENSE` in `platform.env` and never in `platform-migrate.env`.
Every install needs one: LibreDB issues the free license of 1 admin seat and 3 user seats for 12 months, and licenses with more seats, on request at info@libredb.org, as the [install guide](../docs/deploy/install-docker.md#request-a-license) describes.
The file holds the token alone on one line, `ldl1.<kid>.<payload>.<signature>`, and may end with one line break.
A missing or empty file, or one that holds anything else, makes `plan` and `apply` exit 2 while they plan, so `apply` stops before it applies any step, and the message names the file and never its content.
The path must name a regular file: a symbolic link or a directory there makes `plan` and `apply` exit 2 while they plan, with a message that names the path.
The installer checks only the token's shape, and Platform verifies the token when it starts, as its [runtime documentation](../docs/deploy/platform-runtime.md) describes.
The check `platform-license` of `verify` then reads the license line that Platform logged at that start, so a token Platform refuses fails `apply` with exit 4 naming its code, because Platform then adds no user, connection or admin, and the report of `apply` prints the license it found.
The installer registers the token with the redactor as it reads it, so the output and the run log of `plan` and `apply` never carry it.
To renew a license, replace the file and run `apply`, which rewrites `platform.env` and recreates Platform.
The applied configuration keeps the path absolute, so the renewal timer's `apply` reads the same file; keep it in place, because without it that run exits 2 and renews no certificate.
