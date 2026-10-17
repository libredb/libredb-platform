# Backup and restore of a Docker install

This release of the installer has no scheduled backups and no `restore` command, so a Docker install with a managed PostgreSQL is backed up and restored by hand with the commands below.
A backup is one set: the secret store and a `pg_dump -Fc` of the databases `libredb` and `keycloak`, taken together.
The secret store must come from the same set as the databases, because it holds the role passwords, the client secrets and every seal key ever issued, retired ones included, and the databases hold envelopes sealed to those keys.
With an external PostgreSQL, the site backs up its server, and this runbook covers only the secret store.

Run every command as root on the install host.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`, and `BACKUP` names the directory of one backup set.

## Back up

```sh
(
set -eu
BACKUP="/var/backups/libredb/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$BACKUP"
tar -C /opt/libredb -czf "$BACKUP/secrets.tgz" secrets
for db in libredb keycloak; do
  docker exec libredb-postgres-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -Fc -d "$1"' sh "$db" > "$BACKUP/$db.dump"
done
echo "$BACKUP"
)
```

Keep backup sets for the retention period of your site, and at least as long as any key retired by a seal key rotation could still be needed.
The set holds every secret of the installation, so store it like the secrets themselves.

## Restore

1. Stop the apps and Keycloak, which leaves PostgreSQL and the edge running:

   ```sh
   docker compose -p libredb -f /opt/libredb/compose.yaml stop platform studio keycloak
   ```

2. Put back the secret store of the set, then each database as it was; the archive recreates every object with its owner and its privileges:

   ```sh
   (
   set -eu
   tar -C /opt/libredb -xzf "$BACKUP/secrets.tgz"
   for db in libredb keycloak; do
     docker exec -i libredb-postgres-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U postgres --clean --if-exists --exit-on-error -d "$1"' sh "$db" < "$BACKUP/$db.dump"
   done
   )
   ```

3. Apply the configuration, which provisions the roles and role settings again (a `-Fc` archive carries neither), sets the restored role passwords, and starts and verifies every component:

   ```sh
   /opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
   ```

4. Review what the restore undid: every grant and revocation made after the backup point is gone, so a user whose access was withdrawn since then has it again.
   Withdraw it again with the statements of [break-glass.md](break-glass.md), and end the sessions that predate the restore by rotating Studio's `JWT_SECRET` and Platform's `AUTH_SECRET` without a previous value ([secret-rotation.md](secret-rotation.md)).

## A database copy older than a seal key retirement

A restored database can hold envelopes sealed to a kid that a later seal key rotation retired; Studio cannot open them while the kid is out of its live keyring.
The query of [seal-key-rotation.md](seal-key-rotation.md#before-you-start) lists them per kid.
Either enter those credentials again in Platform, or bring the key back: set its `state` from `retired` to `live` in `/opt/libredb/secrets/secrets.json`, remove its kid from `bridge.sealKeys.retire`, and apply, which writes it to Studio's keyring again.
Then rotate away from it as the seal key runbook describes.
