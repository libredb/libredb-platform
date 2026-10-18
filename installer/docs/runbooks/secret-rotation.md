# Secret rotation

The installer generates every secret of an installation once and keeps it in `/opt/libredb/secrets/secrets.json` (mode 0600, owned by root), the secret store.
It never regenerates a secret that the store holds, so rotating a generated secret means deleting it from the store and running `apply`.
`apply` then generates a new value and converges every consumer in one run: the Keycloak client, the PostgreSQL role, the env files, and the containers that read them, which it recreates.

Secret changes are additive wherever the software allows it, because a rollback cannot restore an old value: keep a backup of `/opt/libredb/secrets` from before the rotation until the new value works.
The seal keypair and the `libredb-installer` client have runbooks of their own: [seal-key-rotation.md](seal-key-rotation.md) and [installer-client.md](installer-client.md).

Run every command as root on the install host, which needs `python3`.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`.

## Delete a secret from the store

Set `SECRET_NAME` to the name of the secret, then remove it with an atomic rewrite that keeps the file's mode:

```sh
python3 - "$SECRET_NAME" <<'EOF'
import json, os, sys
path = "/opt/libredb/secrets/secrets.json"
with open(path) as file:
    store = json.load(file)
if store["values"].pop(sys.argv[1], None) is None:
    sys.exit(f"{path} holds no secret {sys.argv[1]}")
fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as file:
    file.write(json.dumps(store, indent=2) + "\n")
os.replace(path + ".new", path)
EOF
```

Then apply, which generates the new value and converges its consumers:

```sh
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
```

The names below are the ones the store uses.

## Studio JWT_SECRET

Name: `studio-jwt-secret`.
Studio signs its session cookies with it, so the new value signs out every Studio user at once, and each signs in again through Keycloak, without a password when the Keycloak session is still alive.
`studio-deploy` recreates Studio with the new value.
Studio has no previous-value list for it, so this rotation is the one global Studio logout.

## Platform AUTH_SECRET

Name: `platform-auth-secret`.
Platform decodes its session cookies with the current and, during a rotation, the previous value, so a rotation keeps every Platform session alive when the old value stays for one session lifetime.

1. Copy the current value to a root-only file outside the secret store:

   ```sh
   install -m 0600 -o root -g root /dev/null /root/libredb-auth-secret-previous
   python3 -c 'import json; print(json.load(open("/opt/libredb/secrets/secrets.json"))["values"]["platform-auth-secret"])' > /root/libredb-auth-secret-previous
   ```

2. Delete `platform-auth-secret` from the store as above, set `platform.authSecretPreviousFile` in the configuration to that file, and apply:

   ```yaml
   platform:
     authSecretPreviousFile: /root/libredb-auth-secret-previous
   ```

   `platform-deploy` writes the new value as `AUTH_SECRET` and the old one as `AUTH_SECRET_PREVIOUS` in `/opt/libredb/env/platform.env` and recreates Platform.
   `apply` refuses a file that is missing or empty with exit 2.
   It also stops on a file that holds the current `AUTH_SECRET`, because Platform refuses to start with two equal values.

3. After one session lifetime, 8 days, remove `platform.authSecretPreviousFile` from the configuration, apply again, and delete the file.

To end every Platform session at once, for example after a leak, skip the file: delete the secret and apply without `platform.authSecretPreviousFile`.

## Keycloak client secrets

Names: `keycloak-client-libredb-studio` and `keycloak-client-libredb-platform`.
`keycloak-configure` sets the new secret on the client, and `platform-deploy` or `studio-deploy` recreates the app with it in the same run, so sign-in fails only for the seconds between the two steps.
Platform's signed-in admins keep their sessions through that gap, within `PLATFORM_RECHECK_GRACE_SECONDS`.
This holds for a managed Keycloak and for an external Keycloak whose realm the installer configures.

## PostgreSQL role passwords

Names: `postgres-owner-password`, `postgres-platform-password`, `postgres-studio-password` and, with a managed Keycloak, `postgres-keycloak-password`.
PostgreSQL keeps one password per role, so these changes cannot be additive.
`postgres-provision` finds that the new password does not log in and sets it on the role, and the later steps rewrite every env file that holds it and recreate its consumers: Platform's migrate job runs again, and Platform, Studio or Keycloak restart.
Open connections keep working, but a new connection with the old password fails until its consumer restarted, a few seconds later in the same run.
With an external PostgreSQL provisioned manually, write the script again with `libredb-installer db-script -c "$LIBREDB_CONFIG" -o provision.sql --force` after deleting the secret, where `--force` replaces the script of the first provisioning, have the DBA run it, and then apply.

These secrets are not rotated this way:

- `postgres-superuser-password`: the managed PostgreSQL reads it only when it creates its data directory, so a new value would lock the installer out.
- `postgres-backup-password`: provisioning keeps the password `libredb_backup` was created with.
- `studio-storage-encryption-key`: Studio encrypts its stored data with it, and a new value makes that data unreadable.
