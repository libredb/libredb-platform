# Customer acceptance checklist

This checklist turns each acceptance criterion of a LibreDB on-prem install, R1 to R11 below, into an on-site procedure with a sign-off line.
It also signs off the hardening that every governance install requires and the Keycloak management roles.
It applies to a Docker install on one Linux host, the only install mode of this release.

Every requirement section gives the procedure, the exact command or UI step, the expected observation, the `verify` check ids that cover it where they exist, and a sign-off line.
A line is signed off only when its expected observation holds on the customer's host.
Before a release is installed at a site, the whole checklist runs end to end on the nightly Docker install, and every sign-off line passes there.

## Before you start

Run every command as root on the install host.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`; `/opt/libredb/libredb.yaml` holds the configuration of the last `apply` if you no longer have yours.
`PLATFORM_URL`, `STUDIO_URL` and `AUTH_URL` hold the three URLs that the report of `apply` prints, such as `https://libredb.corp.example`.
The commands read JSON with `jq`; install it on the host, or copy the files to a workstation that has it.

```sh
export LIBREDB_CONFIG=/root/libredb.yaml
export PLATFORM_URL=https://libredb.corp.example STUDIO_URL=https://studio.corp.example AUTH_URL=https://sso.corp.example
```

Confirm the release, and that the images the host runs are the ones it pins:

```sh
/opt/libredb/bin/libredb-installer version
/opt/libredb/bin/libredb-installer images list -c "$LIBREDB_CONFIG"
docker compose -p libredb -f /opt/libredb/compose.yaml ps --format '{{.Service}} {{.Image}}'
```

Expected: `version` prints the release version you install, and every running service runs an image that `images list` prints, pinned by its sha256 digest.
The Platform image does not contain `@libredb/studio` (R6).
A Studio pinned as `git:<sha>` instead of a release reports its package version, which the release manifest records as `studio.reportedVersion` and `studio-canary` compares.

Run `verify` once and keep its JSON for the sections below:

```sh
/opt/libredb/bin/libredb-installer verify -c "$LIBREDB_CONFIG" --output json > /root/libredb-verify.json; echo "exit $?"
jq -r '.checks[] | "\(.result) \(.id) \(.cause // "")"' /root/libredb-verify.json
```

Expected: `exit 0`, and every check `passed`.
`admin-mfa` is a warning check: it reports `warning` instead of failing, and the exit code stays 0, until every account it names has an OTP credential (H1 below).
`platform-license` warns the same way while the license expires within 30 days or is in its 14-day grace period, and when Docker has dropped Platform's license line from a long log.
Any `failed` check makes `verify` exit 4 and names its cause; fix it before you continue.

### Site record

Record the site's configuration; the sections below refer to it.

| Item | Value at this site |
| --- | --- |
| `endpoints.style` (`hostnames` or `ports`) | |
| `tls.mode` (`generated`, `provided` or `external`) | |
| `tls.caBundleFile` (the customer's root CA, for `provided` and `external`) | |
| `tls.external.trustedProxies` (for `external`) | |
| `postgres.mode` (`managed` or `external`), and for `external` its host and `postgres.external.caBundleFile` | |
| `keycloak.mode` (`managed` or `external`), and for `external` its `provisioning` (`installer` or `manual`) and the Keycloak version | |

- `endpoints.style: ports` is a documented downgrade from separate hostnames, kept for sites where DNS is impossible: browsers scope cookies and HSTS by host and not by port, so each app's server receives the cookies of the others, and script on one app can set cookies that the others read, so a compromise of one app reaches the sessions of the others.
- `tls.mode: provided` takes one chain and key per endpoint, and `tls.caBundleFile` holds the customer's root CA; a leaf issued by an intermediate validates when the chain file holds the intermediate and the bundle only the root.
- `tls.mode: external` puts the edge behind the customer's TLS proxy: the edge's plain HTTP port (`tls.external.httpPort`) must be reachable only from that proxy, with a host firewall rule in the `DOCKER-USER` chain, because an `INPUT` rule does not filter a port Docker publishes, and `tls.external.trustedProxies` names that proxy's addresses and nothing wider.
- An external PostgreSQL is addressed by a DNS name that its certificate covers, never an IP address, and `postgres.external.caBundleFile` holds the CA that issued that certificate.
- An external Keycloak with `provisioning: manual` is configured by the site's identity team from `/opt/libredb/bin/libredb-installer keycloak export -c "$LIBREDB_CONFIG" -o keycloak-export`, which writes `keycloak-export/libredb-keycloak-export.json`, or from [the console steps](keycloak-manual.md); that team also assigns the `realm-management` roles `view-users` and `view-clients` to the service account of `libredb-platform` by hand, and the site supplies both client secrets through `studioClientSecretEnv` or `studioClientSecretFile` and `platformClientSecretEnv` or `platformClientSecretFile`.
  The installer's check of such a realm covers neither the clock skew nor the Keycloak version, so the site states its Keycloak version (25 or newer, 26.8.1 tested) on the sign-off line of R3.

- [ ] Sign-off SITE: the site record above is complete, and for `tls.mode: external` the `DOCKER-USER` rule admits only the upstream proxy to the edge's HTTP port. Name: ________ Date: ________

## R1 Platform and Studio run as independent services

**Requirement:** Platform and Studio run as independent services on their own ports, and each starts, serves and passes readiness with the other stopped.

**Procedure:** Stop Platform, check that Studio stays ready and that a granted user still runs a query, then start Platform; do the reverse with Studio.

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml stop platform
curl --cacert /opt/libredb/ca/ca.crt -s -o /dev/null -w '%{http_code}\n' "$STUDIO_URL/api/ready"
docker compose -p libredb -f /opt/libredb/compose.yaml start platform
docker compose -p libredb -f /opt/libredb/compose.yaml stop studio
curl --cacert /opt/libredb/ca/ca.crt -s -o /dev/null -w '%{http_code}\n' "$PLATFORM_URL/api/health/ready"
docker compose -p libredb -f /opt/libredb/compose.yaml start studio
/opt/libredb/bin/libredb-installer status
```

**UI step:** While Platform is stopped, a user with a grant (R4) runs `SELECT 1` on the granted connection in Studio's editor.
While Studio is stopped, an admin changes that grant's level on the connection's page in Platform.

**Expected:** Studio's `/api/ready` answers `200` with Platform stopped, and the query returns its row.
Platform's `/api/health/ready` answers `200` with Studio stopped, and the grant change is saved.
After both starts, `status` shows every container running and healthy.
The nightly `installer/e2e/independence.spec.ts` asserts the same.

**Verify checks:** `components-healthy`, `platform-ready`, `studio-ready`

- [ ] Sign-off R1: Studio served a granted query with Platform stopped, and Platform changed a grant with Studio stopped. Name: ________ Date: ________

## R2 Platform and Studio use one PostgreSQL database

**Requirement:** One database `libredb` holds the schemas `platform`, `studio` and `bridge`.

**Command:**

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT current_database(), string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('platform', 'studio', 'bridge')"
```

**Expected:** One row `libredb|bridge,platform,studio`.
The privilege matrix of the database roles and the bridge privileges pass in `verify`.
For an external PostgreSQL, the site record names its DNS host and `postgres.external.caBundleFile`.

**Verify checks:** `postgres-privileges`, `bridge-privileges`, `bridge-contract`

- [ ] Sign-off R2: database `libredb` holds schemas `platform`, `studio` and `bridge`, and the privilege checks passed. Name: ________ Date: ________

## R3 One Keycloak realm with single sign-on

**Requirement:** A user signed in to Platform opens Studio without entering credentials again.

**UI step:** In a fresh browser that trusts the site's CA, open `$PLATFORM_URL`, choose Continue with SSO and sign in as an account that holds `libredb:admin`.
Click Studio in Platform's sidebar, which opens Studio in a new tab.
In that tab, open `$STUDIO_URL/api/auth/me`.
Then, in another fresh browser, sign in to Platform as an account that holds only `libredb:user`.

**Expected:** Studio opens signed in, without Keycloak's login form, and `/api/auth/me` answers a user whose `role` is `admin`.
Studio takes the role from the claim `libredb_roles` of the ID token, so this shows the claim reaches Studio through a code login.
The `libredb:user` account does not get into Platform, which admits only `libredb:admin`, and is sent on to Studio.
For an external Keycloak with `provisioning: manual`, the identity team also shows the claim `libredb_roles` in the realm console under Clients, `libredb-studio`, Client scopes, Evaluate, Generated ID token, for a user that holds `libredb:admin`, and states the Keycloak version.

**Verify checks:** `studio-oidc-chain`, `oidc-discovery-in-network`, `platform-signin-redirect`, `platform-admin-api`, `clock-skew`, `no-proxy`

- [ ] Sign-off R3: an admin signed in to Platform opened Studio without a second login, and Studio reported the role `admin`; Keycloak version: ________. Name: ________ Date: ________

## R4 A Platform grant decides what Studio lists, in user mode

**Requirement:** A Platform grant makes Studio list exactly the user's granted connections, in user mode, and another user never sees the connection.

**UI step:** In Platform, open Connections, New connection, and create a connection to a customer database with a read-only credential and a read-write credential.
On the connection's page, choose Grant access, search for user A, and grant the level `read`.
User A and user B each hold only `libredb:user` and are signed in to Studio in their own browsers.
In each Studio tab, open the browser's developer console and run:

```js
(await (await fetch("/api/connections/managed")).json()).connections.map((connection) => connection.id)
```

**Expected:** Within seconds, user A's list holds exactly the granted connection, and user B's list is empty `[]`.
Studio's editor of user A shows the connection, and user B's does not.

**Verify checks:** `bridge-contract`, `seal-canary-published`, `studio-canary`, `studio-heartbeat`

- [ ] Sign-off R4: user A saw exactly the granted connection, and user B saw none. Name: ________ Date: ________

## R5 Studio settings are managed from Platform

**Requirement:** Changing an allowlisted setting in Platform changes Studio's behaviour without a restart.

**Command and UI step:** Note Studio's container id, then in Platform open Studio settings, set `queryLog.statementCapture` to `full`, and save it.

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml ps -q studio
```

In user A's Studio tab, run in the developer console:

```js
(await (await fetch("/api/connections/policy")).json()).statementCapture
```

Run the `docker compose ... ps -q studio` command again, and set the setting back to `redacted`, the default of a governance install.

**Expected:** Within seconds the console answers `"full"`, and the container id is the same before and after.

**Verify checks:** `bridge-notify-roundtrip`

- [ ] Sign-off R5: Studio applied `queryLog.statementCapture` from Platform with the same container id, and the setting is back to `redacted`. Name: ________ Date: ________

## R6 Platform does not embed Studio

**Requirement:** `@libredb/studio` appears nowhere in Platform's dependencies, source or build.

**Command:** Resolve the package inside the Platform image that the host runs, and resolve `next` as a control that the command itself works:

```sh
PLATFORM_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$(docker compose -p libredb -f /opt/libredb/compose.yaml ps -q platform)")
docker run --rm --entrypoint node "$PLATFORM_IMAGE" -e "require.resolve('@libredb/studio')"; echo "exit $?"
docker run --rm --entrypoint node "$PLATFORM_IMAGE" -e "console.log(require.resolve('next'))"
```

**Expected:** The first `docker run` fails with `Error: Cannot find module '@libredb/studio'` and `code: 'MODULE_NOT_FOUND'`, then `exit 1`.
The second prints a path under `/app/node_modules/next/`.
Platform's own test `src/shared/lib/no-embedded-studio.test.ts` covers its dependencies, configuration and source.

- [ ] Sign-off R6: `require.resolve('@libredb/studio')` failed with `MODULE_NOT_FOUND` in the installed Platform image. Name: ________ Date: ________

## R7 An installer that installs or reuses Keycloak and PostgreSQL

**Requirement:** A clean run and a re-run converge, with and without an existing Keycloak and PostgreSQL; this release installs with Docker on one Linux host, and Kubernetes comes in the next release.

**Command:** After the install, plan and apply again with the same configuration:

```sh
/opt/libredb/bin/libredb-installer preflight -c "$LIBREDB_CONFIG"
/opt/libredb/bin/libredb-installer plan -c "$LIBREDB_CONFIG"
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes; echo "exit $?"
/opt/libredb/bin/libredb-installer status
```

An external PostgreSQL with `provisioning: installer` or an external Keycloak with an admin credential takes that credential through its `Env` or `File` reference on these runs, such as `sudo --preserve-env=<variable>`.
An external PostgreSQL with `provisioning: manual` was provisioned by the site's DBA with the script of `/opt/libredb/bin/libredb-installer db-script -c "$LIBREDB_CONFIG" -o provision.sql`.

**Expected:** `preflight` prints `Preflight passed`, `plan` prints `No changes`, and the second `apply` changes nothing, ends with every `verify` check passed or with warnings only from `admin-mfa` and `platform-license`, and exits 0.
`status` lists every step as applied or unchanged and every container healthy.
The modes of the site record are the ones installed; the nightly `installer/test/e2e/matrix.test.ts` converges all four combinations of PostgreSQL mode and Keycloak mode twice.

**Verify checks:** `postgres-privileges`, `components-healthy`, `edge-tls`, `platform-ready`, `studio-ready`

- [ ] Sign-off R7: the install converged, and a re-run planned and changed nothing, in the PostgreSQL and Keycloak modes of the site record. Name: ________ Date: ________

## R8 Studio enforces grants on the server

**Requirement:** Studio refuses requests for a connection that is not granted, an inline connection, and the MCP and agent paths.

**UI step:** With the grant of R4 at level `read`, user B runs these in the developer console of its Studio tab, with `<id>` set to the connection id that user A's list showed:

```js
(await fetch("/api/db/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: "<id>", sql: "SELECT 1" }) })).status
(await fetch("/api/db/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connection: { id: "inline", name: "Inline", type: "postgres", host: "db.corp.example", port: 5432, database: "postgres", user: "x", password: "x" }, sql: "SELECT 1" }) })).status
(await fetch("/api/mcp/token", { method: "POST" })).status
(await fetch("/api/mcp")).status
(await fetch("/api/agent/runs")).status
(await fetch("/api/agent/classify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "List the orders" }) })).status
```

User A then runs an `INSERT` into a table of the granted database in Studio's editor.

**Expected:** `404` (`CONNECTION_NOT_FOUND`) for the connection user B was not granted, `403` (`CUSTOM_CONNECTIONS_DISABLED`) for the inline connection, `409` for the MCP token, `401` for `/api/mcp`, and `404` for both agent paths, because MCP and the agent stay refused under governance in this release.
User A's `INSERT` is refused by the customer database with SQLSTATE `42501`, and Studio shows the PostgreSQL error `permission denied for table <table>`, because a `read` grant opens the connection with the read-only credential.

- [ ] Sign-off R8: Studio refused the ungranted, inline, MCP and agent requests with the statuses above, and the database refused user A's write. Name: ________ Date: ________

## R9 Query audit stays visible in Platform

**Requirement:** Every executed statement appears in Platform's audit page with user, connection and outcome.

**UI step:** User A runs a `SELECT` in Studio's editor on the granted connection.
In Platform, an admin opens Audit.

**Expected:** Within seconds the page lists the statement with user A, the connection's name, the source `editor` and the outcome `success`.
With the default capture `redacted`, the statement shows its tables and columns and masks its literals.
The nightly `installer/e2e/interop.spec.ts` test "query event visible in Platform audit" also covers transaction and profile events.

- [ ] Sign-off R9: Platform's audit page showed user A's statement with user, connection and outcome. Name: ________ Date: ________

## R10 Grant revocation takes effect within 2 s

**Requirement:** A revoked grant answers 404 within 2 s, independent of the session's lifetime.

**UI step:** User A starts this poll in the developer console of its Studio tab, with `<id>` set to the granted connection's id:

```js
for (let last = 0; ; await new Promise((resolve) => setTimeout(resolve, 100))) { const status = (await fetch("/api/db/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: "<id>", sql: "SELECT 1" }) })).status; if (status !== last) console.log(new Date().toISOString(), status); last = status; if (status === 404) break; }
```

An admin then revokes user A's grant on the connection's page in Platform, and notes the time of the confirmation.
Next, the admin opens Studio users in Platform and chooses Revoke Studio sessions for user A, while user A reloads Studio.

**Expected:** The console prints `200`, then `404` within 2 s of the revocation's confirmation.
After Revoke Studio sessions, user A's next Studio request answers `401` and Studio asks user A to sign in again.
Record the latencies `revocation` and `session revocation` that the latest nightly run of `installer/e2e/interop.spec.ts` printed.
The break-glass procedures of [break-glass](runbooks/break-glass.md) withdraw access the same way while Keycloak or Platform is down, and `installer/e2e/runbooks.spec.ts` drills them.

- [ ] Sign-off R10: the revoked grant answered 404 within 2 s, and the session revocation answered 401; nightly latencies: revocation ______ ms, session revocation ______ ms. Name: ________ Date: ________

## R11 Internal CA, and no runtime call leaves the site unless configured

**Requirement:** The installation works with an internal CA, and on a site with outbound network access no runtime call leaves the customer network unless configured.

**Command:**

```sh
/opt/libredb/bin/libredb-installer tls export-ca -o /root/libredb-ca.crt
openssl x509 -in /root/libredb-ca.crt -noout -subject -enddate
jq -r '.checks[] | select(.id == "edge-tls" or .id == "no-proxy") | "\(.result) \(.id)"' /root/libredb-verify.json
```

**Expected:** The internal CA prints its subject and an end date years ahead, and `edge-tls` and `no-proxy` passed.
With `tls.mode: generated`, the browsers of R3 trusted the exported internal CA; with `provided` or `external`, they trusted the customer's root CA of `tls.caBundleFile`.
The nightly `installer/test/e2e/egress.test.ts` showed that no packet left the host during `apply`, `verify` and the interop suite.
Its egress rules cover IPv4 only.
The managed Keycloak runs with `LIQUIBASE_ANALYTICS_ENABLED=false`, so its first start contacts no Liquibase server.
Mark the nightly part of R1 and R11 as pending in the sign-off unless the three latest runs of every job of `.github/workflows/installer-nightly.yml` passed, each PostgreSQL and Keycloak combination and the egress job included.

**Verify checks:** `edge-tls`, `no-proxy`, `oidc-discovery-in-network`

- [ ] Sign-off R11: `verify` passed with the site's CA, and the nightly egress test passed for this release. Name: ________ Date: ________

## Required hardening

Every governance install requires this hardening.

**H1 Keycloak MFA for every account that holds `libredb:admin` or `manage-users`.**
`verify`'s warning check `admin-mfa` lists each account that holds `libredb:admin`, or the `realm-management` role `manage-users` or its composite `realm-admin`, directly or through a group, without an OTP credential; service accounts are left out, because they never sign in interactively.
It reads Keycloak as `libredb-installer` for a managed Keycloak and as the service account of `libredb-platform` for an external one, and when no such credential is available it warns that it did not run.
The first admin and the user manager that the installer creates must set up a TOTP device at their first login.

```sh
/opt/libredb/bin/libredb-installer verify -c "$LIBREDB_CONFIG" --output json | jq -r '.checks[] | select(.id == "admin-mfa") | "\(.result) \(.cause // "")"'
```

Expected: `passed`.
A site that enforces the second factor outside Keycloak's OTP, such as at an upstream identity provider, names that mechanism on the sign-off line, because `admin-mfa` recognizes OTP credentials only.

- [ ] Sign-off H1: MFA is enforced for every account that holds libredb:admin or manage-users, and `admin-mfa` reported `passed`. Name: ________ Date: ________

**H2 The keyring is delivered as a file.**

```sh
stat -c '%a %u %n' /opt/libredb/secrets/studio-keyring.json
grep -c '^GOVERNANCE_PRIVATE_KEYS_FILE=/etc/libredb/governance/keyring.json$' /opt/libredb/env/studio.env
```

Expected: `400 1001 /opt/libredb/secrets/studio-keyring.json`, and `1`: Studio reads its seal private keys from the file mounted read-only, never from an environment variable.

- [ ] Sign-off H2: Studio's keyring is the 0400 file owned by uid 1001, named by GOVERNANCE_PRIVATE_KEYS_FILE. Name: ________ Date: ________

**H3 `MIGRATE_DATABASE_URL` is absent from every runtime container.**

```sh
for c in $(docker compose -p libredb -f /opt/libredb/compose.yaml ps -q); do printf '%s ' "$(docker inspect --format '{{.Name}}' "$c")"; docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -c '^MIGRATE_DATABASE_URL='; done
grep -l MIGRATE_DATABASE_URL /opt/libredb/env/*.env
```

Expected: every running container prints `0`, and only `/opt/libredb/env/platform-migrate.env`, the env file of the migrate job, holds the variable.
The commands print counts and file names only, never a value.

- [ ] Sign-off H3: no running container has MIGRATE_DATABASE_URL, and only the migrate job's env file holds it. Name: ________ Date: ________

**H4 `AUTH_SECRET`, `JWT_SECRET` and the seal keys are distinct and independent.**
The `secrets` step draws each of them separately, and the state records each secret's SHA-256 fingerprint, never its value.

```sh
jq -r '.secrets["platform-auth-secret"], .secrets["studio-jwt-secret"]' /opt/libredb/state/state.json
jq -r '.keys[]' /opt/libredb/secrets/studio-keyring.json | while read -r key; do printf '%s' "$key" | sha256sum | cut -d' ' -f1; done
```

Expected: two different fingerprints for `AUTH_SECRET` and `JWT_SECRET`, and a digest per live seal key that differs from both and from each other.

- [ ] Sign-off H4: AUTH_SECRET, JWT_SECRET and every seal key are distinct. Name: ________ Date: ________

## Keycloak management roles

A separate user manager administers the realm's users, and the first LibreDB admin holds no Keycloak management role, because an account that can manage users can give `libredb:admin` to anyone.

**UI step:** Open the realm console: for a managed Keycloak, `/opt/libredb/bin/libredb-installer keycloak console -c "$LIBREDB_CONFIG"` prints its URL and the SSH tunnel that reaches it; for an external Keycloak, the identity team opens its own console.
Under Clients, `realm-management`, Roles, open each role and its Users in role tab, and under Groups, check the Role mapping of each group for a `realm-management` role.
Open the first admin's Role mapping under Users.

**Expected:** The only human account that holds a `realm-management` role is the user manager (`keycloak.userManager.username`, default `libredb-user-manager`), with exactly `manage-users`, `view-users`, `query-groups` and `view-clients`, and no `libredb` role.
In a reused realm the holders are accounts of the customer's identity team instead, and the installer's user manager exists only when `keycloak.userManager.enabled` is set.
Besides people, only service accounts hold such roles: `libredb-platform` with `view-users` and `view-clients`, and for a managed Keycloak `libredb-installer` with `realm-admin`.
The first admin holds `libredb:admin` and no `realm-management` role.

- [ ] Sign-off ROLES: the only Keycloak account that holds a realm-management role is the user manager with manage-users, view-users, query-groups and view-clients, or in a reused realm an account of the customer's identity team, and the first admin holds none. Name: ________ Date: ________

## Operations runbooks

These runbooks are drilled by `installer/e2e/runbooks.spec.ts` where it says so, and the site keeps them at hand:

- [Seal key rotation](runbooks/seal-key-rotation.md), drilled.
- [Secret rotation](runbooks/secret-rotation.md) of Studio's `JWT_SECRET`, Platform's `AUTH_SECRET`, the Keycloak client secrets and the PostgreSQL role passwords.
  The password of the backup role `libredb_backup` and the managed PostgreSQL superuser password are not rotatable in this release.
- [The `libredb-installer` client](runbooks/installer-client.md), drilled.
- [Break-glass](runbooks/break-glass.md), drilled.
- [Backup and restore](runbooks/restore.md), by hand with `pg_dump`, because this release has no scheduled backups.
- [Upgrade](runbooks/upgrade.md) to a later release; downgrade and rollback are not supported.
- [Keycloak roles and realm settings](runbooks/keycloak-roles.md): assign `libredb:admin` and `libredb:user` directly or through a group, never only through a composite role, and lift a lockout.

- [ ] Sign-off OPS: the site's operators have the runbooks, and the latest nightly drill of `installer/e2e/runbooks.spec.ts` passed for this release. Name: ________ Date: ________

## Final sign-off

- [ ] Sign-off FINAL: every sign-off line above passed on this host for release ________. Customer: ________ LibreDB: ________ Date: ________
