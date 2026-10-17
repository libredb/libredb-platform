# Seal key rotation

Platform seals every database credential to Studio's public seal key and can never open or re-seal one.
Rotating the keypair therefore adds the new key to Studio first, switches Platform to it, has an admin enter the credentials again, and only then retires the old key.
Every step is additive, because a rollback cannot restore a secret value: until the last step, the previous configuration still works.

Run every command as root on the install host.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`.
`/opt/libredb/libredb.yaml` holds the configuration of the last `apply` with its `--set` overrides, if you no longer have yours.

Three fields of the configuration drive the rotation:

| Field | Effect |
| --- | --- |
| `bridge.sealKeys.issueNew` | `true` adds one new live key to Studio's keyring while the active key is the newest live key, so applying the same file again adds no second key |
| `bridge.sealKeys.activeKid` | The kid whose public key Platform receives as `BRIDGE_SEAL_PUBLIC_KEY`; without it, the oldest live key |
| `bridge.sealKeys.retire` | Kids to remove from the live keyring; the secret store keeps them in escrow |

`apply` refuses with exit 6, and changes nothing, when the live keyring already holds 16 kids, the limit of Studio's keyring, and `issueNew` would add one, when `retire` names the active kid or a kid the secret store never issued, when `activeKid` names a retired or unknown kid, and when an envelope in `bridge.connections_v1` still uses a kid that `retire` names.

## Before you start

Note the kids every live Studio instance holds and the result of its canary per kid:

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT instance_id, keyring_kids, canary FROM bridge.studio_instance WHERE last_seen_at > now() - interval '2 minutes' ORDER BY instance_id"
```

List the connections per kid that seals their credentials; the kid is the second dot-separated field of each envelope:

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT e.kid, e.level, e.connection_id, e.name FROM (SELECT connection_id, name, 'read' AS level, split_part(read_secret, '.', 2) AS kid FROM bridge.connections_v1 UNION ALL SELECT connection_id, name, 'write', split_part(write_secret, '.', 2) FROM bridge.connections_v1 WHERE write_secret IS NOT NULL) e ORDER BY e.kid, e.name, e.level"
```

The kid that seals today's credentials is the old kid of this rotation.

## 1. Add the new key to Studio

Set `issueNew` in the configuration:

```yaml
bridge:
  sealKeys:
    issueNew: true
```

Apply it:

```sh
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
```

The `secrets` step issues the new key into `/opt/libredb/secrets/secrets.json`, and `studio-deploy` writes the keyring with both keys and recreates Studio.
Platform keeps sealing to the old key, so nothing changes for users.

## 2. Wait for every Studio instance

Run the heartbeat query again until every live instance lists the new kid in `keyring_kids` and still reports `ok` in `canary` for the old kid:

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT instance_id, keyring_kids, canary FROM bridge.studio_instance WHERE last_seen_at > now() - interval '2 minutes' ORDER BY instance_id"
```

The kid in `keyring_kids` that was not there before is the new kid.

## 3. Switch Platform to the new key

Turn `issueNew` off and name the new kid as the active kid in the same edit, because `issueNew` would otherwise add a third key now that the active key is the newest one:

```yaml
bridge:
  sealKeys:
    issueNew: false
    activeKid: <new kid>
```

Apply it:

```sh
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
```

`platform-deploy` recreates Platform with the new `BRIDGE_SEAL_PUBLIC_KEY`, and Platform publishes a canary for the new kid at start.
The `verify` step at the end of `apply` waits up to 60 seconds until every live Studio instance reports `ok` for the new kid (check `studio-canary`), and `apply` exits 4 when one does not.
New and edited connections are now sealed to the new key; the old key still opens every existing credential.

## 4. Enter the credentials again

Every credential still sealed under the old kid must be entered again in Platform, in the edit form of its connection, which warns about each credential sealed to an earlier key.
The query of [Before you start](#before-you-start) lists them per kid; repeat it until no row names the old kid:

```sh
/opt/libredb/bin/libredb-installer db-shell --as platform -c "SELECT e.kid, e.level, e.connection_id, e.name FROM (SELECT connection_id, name, 'read' AS level, split_part(read_secret, '.', 2) AS kid FROM bridge.connections_v1 UNION ALL SELECT connection_id, name, 'write', split_part(write_secret, '.', 2) FROM bridge.connections_v1 WHERE write_secret IS NOT NULL) e ORDER BY e.kid, e.name, e.level"
```

Re-entering a credential seals it again, even an unchanged one, and Studio treats that as a changed envelope: it closes the affected users' provider sessions and rolls back their open transactions.
Schedule this step outside working hours.

The query reads `bridge.connections_v1`, which publishes only active connections that are not deleted.
A connection that is inactive keeps its old envelope, so enter its credentials again before you activate it after step 5.

## 5. Retire the old key

Name the old kid in `retire`, and keep `activeKid`:

```yaml
bridge:
  sealKeys:
    issueNew: false
    activeKid: <new kid>
    retire: [<old kid>]
```

Apply it:

```sh
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
```

`apply` first checks that no envelope in `bridge.connections_v1` uses the old kid, and refuses with exit 6, naming each connection, when one does.
It then deletes the old kid's row from `platform.seal_canary` as `libredb_platform`, because Platform only inserts canaries and the row would otherwise make every heartbeat report `UNKNOWN_KID` for good, marks the key retired in the secret store, and recreates Studio with a keyring that holds only the live keys.
The secret store keeps the retired private key in escrow with the state `retired`, so a database copy from before this step can still be opened after a restore, as [restore.md](restore.md) describes; keep `/opt/libredb/secrets` in every backup for the backup retention period.
Leave the kid in `retire`: applying it again changes nothing.

## A compromised private key

If a Studio private key leaks, rotate as above and also rotate every governed database credential at its database, because the leaked key opens every old envelope in any copy of the database.
