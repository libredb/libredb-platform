# Rotate the libredb-installer client

With a managed Keycloak, the installer reaches the Admin API only as the realm-scoped service client `libredb-installer`, whose secret lives in `/opt/libredb/secrets/installer.env` (mode 0600, owned by root) and nowhere else, so no application container can read it.
Rotating it regenerates the secret in Keycloak with the current secret and stores the new one in that file.
An installation against an external Keycloak has no such client: the site rotates the credential that `keycloak.external` references.

Run every command as root on the install host, which needs `curl` and `python3`.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/root/libredb.yaml`.
The commands reach Keycloak on its loopback admin port: set `LIBREDB_REALM` and `LIBREDB_KEYCLOAK_ADMIN_PORT` when the configuration sets `keycloak.realm` or `keycloak.adminPort`, which default to `libredb` and `18080`.

## 1. Regenerate the secret

The client authenticates with its current secret, asks Keycloak for a new one through `POST /admin/realms/<realm>/clients/<id>/client-secret`, and writes the new secret to `installer.env` in one atomic rename.
Secrets and tokens reach `curl` on standard input, so no process listing shows them, and the subshell stops at the first failure without closing your shell:

```sh
(
set -eu
. /opt/libredb/secrets/installer.env
realm="${LIBREDB_REALM:-libredb}"
keycloak="http://127.0.0.1:${LIBREDB_KEYCLOAK_ADMIN_PORT:-18080}"
token=$(printf '%s' "$KEYCLOAK_INSTALLER_CLIENT_SECRET" | curl -fsS --data-urlencode grant_type=client_credentials --data-urlencode "client_id=$KEYCLOAK_INSTALLER_CLIENT_ID" --data-urlencode client_secret@- "$keycloak/realms/$realm/protocol/openid-connect/token" | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
id=$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- "$keycloak/admin/realms/$realm/clients?clientId=$KEYCLOAK_INSTALLER_CLIENT_ID" | python3 -c 'import json, sys; print(json.load(sys.stdin)[0]["id"])')
secret=$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X POST -H @- "$keycloak/admin/realms/$realm/clients/$id/client-secret" | python3 -c 'import json, sys; print(json.load(sys.stdin)["value"])')
umask 077
printf 'KEYCLOAK_INSTALLER_CLIENT_ID=%s\nKEYCLOAK_INSTALLER_CLIENT_SECRET=%s\n' "$KEYCLOAK_INSTALLER_CLIENT_ID" "$secret" > /opt/libredb/secrets/installer.env.new
mv /opt/libredb/secrets/installer.env.new /opt/libredb/secrets/installer.env
)
```

From the moment Keycloak answers, the old secret gets 401 on a token request, and tokens issued before keep working until they expire.
If the command stops after Keycloak answered but before the rename, `installer.env` still holds the old secret and every `apply` fails at the Admin API, naming the file: set a new secret on the client in the realm console as a realm administrator and write it to `installer.env` in the format above.

## 2. Prove the new secret

Run `apply`; every step that reaches Keycloak authenticates as `libredb-installer` with the new secret, and the run fails at the first Keycloak step when it cannot:

```sh
/opt/libredb/bin/libredb-installer apply -c "$LIBREDB_CONFIG" --yes
```

Back up `/opt/libredb/secrets` afterwards, because a backup taken before the rotation restores a secret that Keycloak no longer accepts.
