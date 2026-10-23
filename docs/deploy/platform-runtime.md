# Platform runtime

This page describes what the Platform image needs at runtime in a self-hosted install: its environment, the PostgreSQL and Keycloak it relies on, its commands and probes, its scheduler, its license, and the runbooks for rotation and break-glass access.
The installer writes every value marked "installer" below; an operator who runs the image without the installer sets the same values by hand.
Platform and Studio never share an environment file.
`src/shared/lib/runtime-config.docs.test.ts` fails when a variable the runtime schema reads is missing from the inventory below, when the migrate container's environment changes, when the break-glass statements drift from the ones the database tests run, or when the License section does not list exactly the license states, or misses a verification failure or the exact text of a refusal.

## Environment inventory

The server checks every variable of `src/shared/lib/runtime-config.ts` when it starts, and stops with one `ConfigError` that names each missing or invalid variable and never prints its value.
An empty value counts as unset.
The `maintain` command runs the same check before it opens any connection.

| Variable | Required when | Value in a self-hosted install | Producer |
| --- | --- | --- | --- |
| `DEPLOYMENT_MODE` | always | `self-hosted` | installer |
| `DATABASE_URL` | always | `libredb_platform` URL with `schema=platform` (pg syntax) | installer |
| `MIGRATE_DATABASE_URL` | migrate container only | `libredb_owner` URL with `schema=platform` (Prisma syntax) | installer |
| `AUTH_SECRET` | always | generated, at least 32 characters, never shared with Studio | installer |
| `AUTH_SECRET_PREVIOUS` | during a rotation | the previous `AUTH_SECRET` | installer config |
| `AUTH_URL` | always (the image sets `NODE_ENV=production`) | `https://<platform>` | installer |
| `AUTH_KEYCLOAK_ISSUER` | self-hosted | `https://<auth>/realms/<realm>` | installer |
| `AUTH_KEYCLOAK_ID` | self-hosted | `libredb-platform` | installer |
| `AUTH_KEYCLOAK_SECRET` | self-hosted | the generated client secret | installer |
| `KEYCLOAK_ADMIN_URL` | when the admin console is internal | in-network Keycloak base URL, such as `http://keycloak:8080` | installer |
| `PLATFORM_ROLE_CLAIM` | optional | `libredb_roles` | default |
| `PLATFORM_ADMIN_ROLE` | optional | `admin` | default |
| `STUDIO_USER_ROLE` | optional | `user` | default |
| `PLATFORM_SESSION_RECHECK_SECONDS` | optional | `300` | default |
| `PLATFORM_RECHECK_GRACE_SECONDS` | optional | `900` | default |
| `DIRECTORY_SYNC_INTERVAL_SEC` | optional | `60` | default |
| `QUERY_LOG_RETENTION_DAYS` | optional | `90` (the database keeps every event younger than 7 days) | installer |
| `STUDIO_PUBLIC_URL` | self-hosted | `https://<studio>` | installer |
| `BRIDGE_SEAL_PUBLIC_KEY` | self-hosted | unpadded base64url of Studio's raw 32-byte X25519 public key | installer |
| `PLATFORM_LICENSE` | self-hosted | the license token from LibreDB | installer config |
| `PLATFORM_API_AUDIENCE` | to turn the bearer API on | `libredb-platform-api` | installer |
| `PLATFORM_API_CLIENT_IDS` | when `PLATFORM_API_AUDIENCE` is set | `libredb-mobile` | installer |
| `PLATFORM_ORGANIZATION_NAME` | migrate container, self-hosted | the customer's name | installer config |
| `NODE_EXTRA_CA_CERTS` | internal CA | `/etc/libredb/ca/ca.crt` | installer |
| `STORAGE_PROVIDER` | optional | `LOCAL` | installer |
| `STORAGE_LOCAL_PATH` | optional | a mounted volume | installer |
| `PLATFORM_DB_VOLUME_BYTES` | optional | size of the managed PostgreSQL volume, unset for an external PostgreSQL | installer |

`PLATFORM_LICENSE` holds the license token that every self-hosted install needs, one line of the form `ldl1.<kid>.<payload>.<signature>`, which the installer reads from the file that `platform.licenseFile` names.
A missing or empty `PLATFORM_LICENSE` stops `serve` and `maintain` with the `ConfigError` that names it.
The server verifies the token as it starts, against the public keys built into the image and, when the license lists hosts, against the host of `AUTH_URL`.
It then logs one line with the license state, which carries the failure code of a token that fails verification or the id, customer and expiry of a valid license, and never the token.
A token that fails verification never stops the server: the install starts in state `invalid`, keeps its existing access, and adds no user, connection or admin until a valid license is installed.
A new value takes effect when `serve` restarts, cloud mode ignores the variable, and the migrate container never receives it, so `migrate`, `migrate-status` and `migrate-resolve` run without it.
The [License](#license) section describes the license states, how seats are counted and which writes a license refuses.
`PLATFORM_API_AUDIENCE` turns on the bearer API under `/api/v1`, which [docs/api/v1.md](../api/v1.md) describes: an access token must carry it in `aud`.
`PLATFORM_API_CLIENT_IDS` is the comma-separated list of the clients whose tokens the API accepts in `azp`, and a set `PLATFORM_API_AUDIENCE` without it stops `serve` with the `ConfigError` that names it.
With `PLATFORM_API_AUDIENCE` unset, and always in cloud mode, every `/api/v1` route answers 404 `API_DISABLED`.
The installer writes both variables only with `mobile.enabled: true` in its configuration, and then also adds the audience `libredb-platform-api` beside `libredb-studio-api` to the access tokens of its client `libredb-mobile`.
`PLATFORM_ORGANIZATION_NAME` is read by the seed only: the first seed names the install's one tenant (slug `default`), and a later run never renames it.
`STORAGE_PROVIDER` and `STORAGE_LOCAL_PATH` are read by the file storage of support attachments, not by the runtime schema.
`PLATFORM_DB_VOLUME_BYTES` is reserved for a database size warning on the admin dashboard, which this release does not show.
`sslcert` and `sslrootcert` in the database URLs and every CA path, `NODE_EXTRA_CA_CERTS` included, must be absolute paths, such as `/etc/libredb/ca/ca.crt`, because the containers do not start in the directory that holds them.

## Variables to leave unset

A self-hosted install leaves these variables unset:

- `ENCRYPTION_KEY`: connection credentials are sealed to `BRIDGE_SEAL_PUBLIC_KEY`, and Platform never decrypts them.
- `OIDC_ISSUER`: Platform signs in through `AUTH_KEYCLOAK_ISSUER`; `OIDC_ISSUER` belongs to Studio only.
- `ADMIN_EMAIL`: a self-hosted install has no password admin, and the first admin is a Keycloak user with the `admin` role.
- `SEED_MODE` outside development: the seed refuses `SEED_MODE=development` in self-hosted mode.

## Migrate container

The `migrate` command runs as a one-shot container (a Docker Compose service that exits, or a Kubernetes Job of the Helm chart, [install-kubernetes.md](install-kubernetes.md)) before every start of a new image.
It receives exactly these variables, and the serve container never receives `MIGRATE_DATABASE_URL`: `serve` refuses to start when it is set.

| Variable | Used by | Value |
| --- | --- | --- |
| `MIGRATE_DATABASE_URL` | the preflight and the Prisma CLI only | `libredb_owner` URL with `schema=platform`, in Prisma syntax |
| `DATABASE_URL` | the seed | `libredb_platform` URL with `schema=platform`, in pg syntax |
| `DEPLOYMENT_MODE` | the seed | `self-hosted` |
| `PLATFORM_ORGANIZATION_NAME` | the seed | the name of the install's one tenant |
| `NODE_EXTRA_CA_CERTS` | the seed and the preflight | `/etc/libredb/ca/ca.crt` when PostgreSQL uses an internal CA |

`migrate` runs three steps and stops at the first failure:

1. The preflight (`docker/migrator/preflight.mjs`) connects as the owner and checks that both URLs carry `schema=platform`, that the server runs PostgreSQL 15 or newer, that it is the primary and not a standby, that the migrating role owns the database, and that the roles `libredb_platform` and `libredb_studio` exist.
2. `prisma migrate deploy` applies the pending migrations with the Prisma CLI pinned in the image.
3. The bundled seed writes the system data and the install's one tenant through `DATABASE_URL`.

The preflight derives its pg TLS settings from the Prisma URL in `MIGRATE_DATABASE_URL`.
TLS is used when the URL has `sslmode=require`, `sslcert` or `sslaccept`.
`sslcert`, an absolute path to the CA certificate, becomes the CA.
`sslaccept=strict` becomes verify-full, which checks the certificate chain and the host name; `sslaccept=accept_invalid_certs`, Prisma's default, accepts any certificate.
`sslmode=prefer`, Prisma's default, connects without TLS, because pg cannot fall back from TLS to plain text.
A client certificate (`sslidentity`, `sslpassword`) is refused.
Running `migrate` twice is safe: the second run applies nothing and the seed changes nothing it already wrote.

## PostgreSQL prerequisites

- PostgreSQL 15 or newer, because the bridge views use the `security_invoker` reloption.
- The database bootstrap, run once as a superuser or a role with `CREATEROLE` and `CREATEDB`: the roles `libredb_owner` (connection limit 5), `libredb_platform` (25) and `libredb_studio` (30), the database `libredb` owned by `libredb_owner`, schema `studio` owned by `libredb_studio`, and the role settings for `search_path` and the idle transaction timeouts.
  `docker/postgres/bootstrap.psql` holds its statements.
- Every URL points at the primary, directly or through a session-mode pooler; a hot standby or transaction pooling breaks migrations and Studio's `LISTEN`.
- Every connection that leaves an isolated private network uses TLS that verifies the server, and the installer sets up such TLS for every connection.

The two URLs spell TLS differently, because the Prisma CLI and pg read different parameters:

```text
DATABASE_URL=postgresql://libredb_platform:<password>@<host>:5432/libredb?schema=platform&sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt
MIGRATE_DATABASE_URL=postgresql://libredb_owner:<password>@<host>:5432/libredb?schema=platform&sslcert=/etc/libredb/ca/ca.crt&sslaccept=strict
```

pg treats `sslmode=require` as verify-full, so `DATABASE_URL` always needs a CA through `sslrootcert` or `NODE_EXTRA_CA_CERTS`.
In Prisma syntax `sslcert` names the CA certificate, not a client certificate, and `sslaccept=strict` is what makes the Prisma CLI verify the server.

## Keycloak contract

Platform relies on these objects in the realm of `AUTH_KEYCLOAK_ISSUER`; the installer creates them, or a site creates them from the installer's export:

- Client `libredb` holds the client roles `admin` and `user`, and client scope `libredb-roles` writes them into the flat ID-token claim `libredb_roles`.
- Client `libredb-platform` is confidential, with the standard flow, PKCE S256, the redirect `https://<platform>/api/auth/callback/keycloak`, the post-logout redirect `https://<platform>/login`, and as default scopes the realm defaults plus `libredb-roles`.
- Its service account holds only the `realm-management` roles `view-users` and `view-clients`, also in its scope mappings when Full Scope Allowed is off.
  Without them the session recheck, directory sync and the user search of the access panel fail, and every Platform session ends when the recheck grace runs out.
- The client keeps Use refresh tokens on: Platform refuses a Keycloak sign-in without a refresh token, because each recheck refreshes the Keycloak session to keep it alive.
- The realm's SSO Session Idle is longer than `PLATFORM_SESSION_RECHECK_SECONDS` (300 s by default), because Platform keeps its Keycloak session alive only at its rechecks.
- Users get `libredb:admin` or `libredb:user` directly or through a group or subgroup.
  An assignment only through a composite role is unsupported: directory sync does not see it.
- Every admin has an email address, which the realm's default `email` scope puts into the ID token; an admin without one lands on `/login?error=IdentityClaimMissing`.

Platform calls the Admin API at `KEYCLOAK_ADMIN_URL` when it is set, and otherwise at the issuer's host with `/realms/<realm>` rewritten to `/admin/realms/<realm>`.
Set `KEYCLOAK_ADMIN_URL` to the in-network Keycloak base URL when the public hostname does not expose the admin console.
An account with only the `user` role lands on `/login?error=AccessDenied` with a link to Studio.

## Probes

| Probe | Path | Answers |
| --- | --- | --- |
| Liveness and startup | `GET /api/health/live` | 200 without any I/O |
| Readiness | `GET /api/health/ready` | 200 only when every migration in the image is applied and `bridge.contract` lists contract version 1, otherwise 503 |

The image's `HEALTHCHECK` calls the liveness probe on `PORT` (3000 by default).
A readiness of 503 after an image change usually means `migrate` did not run or failed.

## Image commands

The image's entry point is `docker/entrypoint.sh`, and each container runs one command:

| Command | What it does |
| --- | --- |
| `serve` | The web server and the in-process scheduler, the default command; refuses to start when `MIGRATE_DATABASE_URL` is set. |
| `migrate` | The preflight, `prisma migrate deploy` and the seed, in the migrate container. |
| `maintain` | Runs every scheduled task once and exits 1 when a task failed. |
| `migrate-status` | `prisma migrate status` with `MIGRATE_DATABASE_URL`. |
| `migrate-resolve` | `prisma migrate resolve --rolled-back <migration>` or `--applied <migration>` with `MIGRATE_DATABASE_URL`, for the failed-migration state P3009. |

Any other argument prints the usage and exits 64.
The docker-smoke job of CI (`scripts/ci/docker-smoke.sh`) builds the image and runs `migrate` twice, `serve` until both probes answer 200, `maintain`, `migrate-status`, and an unknown argument that must exit 64.
It gives `serve` and `maintain` a well-formed token that no key signed, with which Platform starts in state `invalid`, and checks that `serve` without `PLATFORM_LICENSE` stops with the `ConfigError` that names it.
It also marks the newest migration failed, checks that `migrate` then stops with P3009, and repairs the history with `migrate-resolve --rolled-back` and `migrate-resolve --applied`, after which `migrate-status` exits 0.

## P3009 recovery

When a migration fails halfway, Prisma records it as failed, and every later `migrate` stops with P3009 until an operator resolves it:

1. Run `migrate-status` with the migrate container's environment to see the failed migration's name.
2. Read the migrate container's log to see why it failed, and fix the cause, such as a lock timeout, a full disk or a missing privilege.
3. When the failed migration changed nothing, or after undoing what it changed by hand as `libredb_owner`, run `migrate-resolve --rolled-back <migration>`, and then `migrate` again, which applies it anew.
4. When its changes were completed by hand, run `migrate-resolve --applied <migration>` instead, and then `migrate`.

```text
docker run --rm --env-file migrate.env <platform-image> migrate-status
docker run --rm --env-file migrate.env <platform-image> migrate-resolve --rolled-back <migration>
docker run --rm --env-file migrate.env <platform-image> migrate
```

Mount the CA directory into these containers as for `migrate`, such as `-v /etc/libredb/ca:/etc/libredb/ca:ro`.

## Scheduler

`serve` starts an in-process scheduler with three tasks:

| Task | Interval | Work |
| --- | --- | --- |
| `directory-sync` | `DIRECTORY_SYNC_INTERVAL_SEC` (60 s) | Lists the members of the `admin` and `user` roles in Keycloak and writes a session revocation for each one who lost a role, was disabled or was deleted; self-hosted mode only. |
| `query-event-retention` | 6 hours | Deletes query events older than `QUERY_LOG_RETENTION_DAYS` through `bridge.trim_query_events`, never one younger than 7 days. |
| `heartbeat-cleanup` | 1 day | Deletes the heartbeats of Studio instances unseen for 7 days. |

Each run holds `pg_try_advisory_lock(hashtext('libredb:<task>'))` on a connection of its own and skips when another process holds the lock, so any number of replicas and `maintain` runs are safe beside each other.
Each run is recorded in `platform.scheduler_runs`.
`maintain` runs every task once under the same locks, so a cron job or an operator can run the tasks while `serve` is down.

## Connection budget

A Platform replica holds up to 14 connections as `libredb_platform`: Prisma's pool of 10 and the scheduler's lock pool of one connection per task plus one (4 with the three tasks).
A `maintain` run opens up to the same 14 while it runs, and `migrate` uses a few connections as `libredb_owner`, whose connection limit is 5.
Every pool connects with a 5 s timeout and a 30 s query timeout.
A PostgreSQL server shared by the whole install needs:

```text
max_connections >= superuser_reserved_connections + KC_DB_POOL_MAX_SIZE + PlatformReplicas x 14 + StudioReplicas x 10 + 15
```

The installer sets Keycloak's pool to 20 and the per-role connection limits (owner 5, platform 25, studio 30, keycloak 25) on a managed server, and checks the budget on an external one.
This release runs one replica of each component.

## License

Every self-hosted install needs a license from LibreDB, which `PLATFORM_LICENSE` installs with the seats it names, and `serve` does not start in self-hosted mode without it.
Licensing applies only in self-hosted mode.
No license state ends existing access: none deactivates a connection, revokes a grant, ends a session, hides the audit log or stops Platform from starting.

The state follows from the token and the clock on every request:

| State | When | Seats |
| --- | --- | --- |
| `invalid` | the token fails verification | none, so no seat can be added |
| `active` | until 30 days before the license expires | the license's seats |
| `expiring` | from 30 days before the expiry until the expiry | the license's seats |
| `grace` | from the expiry, for 14 days | the license's seats |
| `expired` | from 14 days after the expiry | no seat can be added |

The boundaries are exact to the second: a license that expires at `T` is `expiring` from `T` minus 30 days, in `grace` from `T` and `expired` from `T` plus 14 days.
A token fails verification when it is malformed (`LICENSE_MALFORMED`), when a key that this build does not hold signed it (`LICENSE_UNKNOWN_KID`), when its signature does not verify (`LICENSE_BAD_SIGNATURE`), when it carries no valid license (`LICENSE_PAYLOAD_INVALID`), and when the license lists hosts without the host of `AUTH_URL` (`LICENSE_HOST_MISMATCH`).

Admins see a banner from 30 days before the expiry, in the grace period, after the expiry, for a token that fails verification, and whenever more seats are in use than a valid license allows, which can follow a change of license.
Admin, License (`/admin/license`) shows the state and its dates, the seats in use against the seats allowed, the admins and the users who hold a seat with how Keycloak reports them, and how to renew.
For a token that fails verification it shows the failure code and the seats in use without a limit, because such a token grants no seat, and where a valid license comes from.

A user seat is a Keycloak user with an unexpired grant on a connection that is active and not deleted, which is a user that `bridge.grants_v1` publishes; an admin with such a grant takes a user seat as well.
A user whom Keycloak disables or whose role it removes keeps the seat while the grant stays in effect, because enabling the account again restores the access without a Platform write.
A user seat frees when the user's last such grant is revoked or expires, or when its connection is deactivated or deleted.

An admin seat is a Platform user of a Keycloak account that Keycloak still reports as an enabled admin: the account exists, is enabled and holds `PLATFORM_ADMIN_ROLE` by its effective roles.
An admin seat frees when Keycloak disables the account, deletes it or removes its admin role.
The License page asks Keycloak about each admin at most once a minute.

A license refuses only the writes that would add a user, a connection or an admin:

| Write | Refused when |
| --- | --- |
| A grant on an active connection to a user who holds no user seat, which would give that user access now | the license is invalid or has expired, or every user seat is in use |
| A new connection | the license is invalid or has expired, or more user seats are in use than the license allows |
| Turning a connection active again | the license is invalid or has expired, or the users who hold a seat together with the users of the connection's unexpired grants are more than the license allows |
| The first sign-in of an admin who has no Platform user yet | the license is invalid or has expired, or every admin seat is in use |

Allowed in every state: changing the level or the expiry of a grant in effect, granting a user who holds a seat another connection, a grant on a paused connection, adding a write credential, rebinding a connection, revoking a grant, deactivating or deleting a connection, the sign-in of an admin who has signed in before, and every read.
A grant on a paused connection takes no seat until the connection is turned active again, when the license counts it with the connection's other unexpired grants.
Each of these gated writes locks the row of the install tenant before it counts, so two writes cannot both take the last seat.

A refused write shows the text of its code, and a refused first sign-in ends on the sign-in page with its code instead of `AccessDenied`:

- `LICENSE_EXPIRED`: The license has expired. Existing access keeps working, and adding users, connections or admins needs a renewed license.
- `LICENSE_INVALID`: The license could not be verified. Existing access keeps working, and adding users, connections or admins needs a valid license.
- `LICENSE_USER_SEATS`: Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.
- `LICENSE_ADMIN_SEATS`: Not enough admin seats. Free a seat by removing the admin role from an account in Keycloak, or install a license with more admin seats.

A refused or failed first sign-in of an admin lands on the sign-in page:

| Landing | Title | Text |
| --- | --- | --- |
| `/login?error=LICENSE_ADMIN_SEATS` | Your first sign-in needs a free admin seat | The text of `LICENSE_ADMIN_SEATS` above |
| `/login?error=LICENSE_EXPIRED` | Your first sign-in needs a renewed license | The text of `LICENSE_EXPIRED` above |
| `/login?error=LICENSE_INVALID` | Your first sign-in needs a valid license | The text of `LICENSE_INVALID` above |
| `/login?error=AdminSeatCheckFailed` | Sign-in failed | Try again. If it keeps failing, ask your administrator to check the Platform logs. |

Once an admin exists, the first sign-in of another admin under a valid license that has not expired asks Keycloak whether each admin still holds a seat, which needs the Admin API rights of the service account, `view-users` and `view-clients`, listed in the [Keycloak contract](#keycloak-contract).
When Keycloak cannot be read, that sign-in fails on `/login?error=AdminSeatCheckFailed` and Platform logs the cause; the sign-in of an admin who has signed in before never asks Keycloak about seats.

License keys come from SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ: write to [info@libredb.org](mailto:info@libredb.org) for a new license or a renewal, with what the [Docker install guide](install-docker.md#request-a-license) lists.
To install or renew a license, save the license file you receive at the path that the installer's `platform.licenseFile` names and run `libredb-installer apply -c <libredb.yaml>`, which recreates Platform with it; without the installer, set `PLATFORM_LICENSE` to the token the file holds and restart `serve`.

## Rotation runbooks

Secret changes are additive where the software allows it, because a rollback cannot restore an old value.

### AUTH_SECRET

`AUTH_SECRET` signs and encrypts the Platform session cookie, and a session lives at most 8 days.

1. Generate a new secret of at least 32 characters.
2. Set `AUTH_SECRET_PREVIOUS` to the current value and `AUTH_SECRET` to the new one, and restart `serve`.
   New sessions use the new secret, and existing sessions stay readable through the previous one.
3. After 8 days remove `AUTH_SECRET_PREVIOUS` and restart `serve` again.

The two values must differ, or `serve` refuses to start.
To end every Platform session at once, for example after a leak, set a new `AUTH_SECRET` without `AUTH_SECRET_PREVIOUS`.

### Seal key, from Platform's side

Platform holds only Studio's public key and cannot re-seal a stored credential, so Studio's keyring must hold both keys while the switch happens:

1. Add the new private key to the keyring of every Studio instance and roll Studio.
2. Wait until every live heartbeat in `bridge.studio_instance` lists the new kid in `keyring_kids` and still reports `ok` in `canary` for the old kid.
3. Set `BRIDGE_SEAL_PUBLIC_KEY` to the new public key and restart `serve`.
   At start Platform runs a self-test seal and publishes a canary for the new kid in `platform.seal_canary`; wait until every live heartbeat reports `ok` for it.
4. Re-enter, in the connection form, every credential still sealed under the old kid; the kid is the second dot-separated field of `readSecret` and `writeSecret` in `platform.database_connections`.
5. Remove the old private key from Studio's keyring, delete the old kid's row from `platform.seal_canary`, and keep the old key in escrow for the backup retention period.

If a Studio private key is compromised, rotate every governed database credential as well, because the leaked key opens every old envelope in any database copy.

### Keycloak client secret

1. Regenerate the secret of client `libredb-platform` in Keycloak.
2. Set `AUTH_KEYCLOAK_SECRET` to the new value and restart `serve` in the same step.

Between the two steps sign-in fails and the Admin API refuses the service account; signed-in admins keep their sessions for `PLATFORM_RECHECK_GRACE_SECONDS` (900 s by default), so finish within that grace.

### PostgreSQL role passwords

PostgreSQL keeps one password per role, so a password change cannot be additive:

1. Connect as a superuser or a role with `CREATEROLE` and run `ALTER ROLE libredb_platform PASSWORD '<new password>'`.
2. Update the password in `DATABASE_URL` for `serve`, `maintain` and the migrate container, and restart `serve` at once: open connections keep working, but every new connection fails until the restart.
3. For `libredb_owner`, run `ALTER ROLE libredb_owner PASSWORD '<new password>'` and update `MIGRATE_DATABASE_URL`, which only the migrate container receives; no running process needs a restart.

`libredb_studio` belongs to Studio and is rotated with Studio's runbook.

## Break-glass

When Keycloak is down, Platform admins keep their sessions for the recheck grace, and after that nobody can sign in to Platform.
Access can still be withdrawn in SQL as the Platform runtime role `libredb_platform`, whose writes notify Studio within seconds through the bridge triggers.
`libredb-installer db-shell --as platform` opens such a session on the installation's data network.
The `<id>` is the user's Keycloak id, the `sub` of their tokens.

Remove every connection grant of a user:

```sql
DELETE FROM platform.connection_grants WHERE subject = '<id>';
```

End every Studio session of a user:

```sql
INSERT INTO platform.session_revocations (subject, reason) VALUES ('<id>', 'admin');
```

The revocation's id and `revokedBefore` have database defaults, so the statement needs no other column.
The database tests `tests/db/bridge-grants.db.test.ts` and `tests/db/bridge-revocations.db.test.ts` run these statements as `libredb_platform`.

To stop Studio altogether, stop its compose service.
