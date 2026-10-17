# Break-glass procedures

These procedures withdraw access or stop Studio when the normal path is not available.
They follow the break-glass section of Platform's runtime page, [docs/deploy/platform-runtime.md](../../../docs/deploy/platform-runtime.md#break-glass), with the commands of a Docker install.

Run every command as root on the install host.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`.

## Keycloak is down: withdraw a user's access in SQL

While Keycloak is down nobody can sign in to Platform once the recheck grace of the signed-in admins runs out (`PLATFORM_RECHECK_GRACE_SECONDS`, 900 seconds by default).
Access can still be withdrawn as Platform's runtime role `libredb_platform`, whose writes reach every Studio instance within seconds through the bridge triggers.
`libredb-installer db-shell --as platform` opens such a session in a one-shot container on the installation's data network, `libredb_data`, and keeps the statements in its run log under `/opt/libredb/logs`.

A user is named by their Keycloak id, the `sub` of their tokens, never by the email.
List the users who hold a grant, with their ids:

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT DISTINCT subject, \"subjectUsername\", \"subjectEmail\" FROM platform.connection_grants ORDER BY 2"
```

Set `USER_ID` to the user's id from that list; a Keycloak id holds no quote, so it can stand in the SQL below as it is.

Remove every connection grant of the user, with the statement of Platform's runtime page:

```sql
DELETE FROM platform.connection_grants WHERE subject = '<id>';
```

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "DELETE FROM platform.connection_grants WHERE subject = '$USER_ID'"
```

Studio stops serving the user's connections within about a second: the next request for one answers 404.

End every Studio session and MCP token of the user, with the statement of Platform's runtime page:

```sql
INSERT INTO platform.session_revocations (subject, reason) VALUES ('<id>', 'admin');
```

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "INSERT INTO platform.session_revocations (subject, reason) VALUES ('$USER_ID', 'admin')"
```

The user's next Studio request answers 401.
The revocation's id and `revokedBefore` have database defaults, so the statement needs no other column.
A revocation ends only the sessions that exist now; disable the user in Keycloak once it is back, or the user can sign in to Studio again.

## Studio kill switch

Stop Studio, which ends every Studio session's data access at once and leaves Platform, Keycloak and PostgreSQL running:

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml stop studio
```

Studio's public URL answers 502 from the edge while it is stopped.
Start it again when the cause is dealt with; a full `apply` starts it as well:

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml start studio
```

## PostgreSQL is down

Studio keeps serving from its last governance snapshot until that snapshot is older than `GOVERNANCE_MAX_STALENESS_MS` (120000 ms by default), and then stops all data access by design, because it can no longer see revocations.
Planned PostgreSQL maintenance therefore costs a Studio data outage of the downtime minus that window, and Platform is unavailable for the whole downtime.
Check the state of every container, PostgreSQL included:

```sh
/opt/libredb/bin/libredb-installer status
```

Once PostgreSQL is back, Studio reloads its snapshot on its own; `apply -c "$LIBREDB_CONFIG" --yes` restarts a managed PostgreSQL that does not come back by itself.
