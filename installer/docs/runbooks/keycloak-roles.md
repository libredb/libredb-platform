# Keycloak roles and realm settings

LibreDB reads two client roles, `admin` and `user`, of the role-holder client `libredb`, which reach both apps as the flat ID-token claim `libredb_roles` through the client scope `libredb-roles`, as the [Keycloak contract](../../../docs/deploy/platform-runtime.md#keycloak-contract) of Platform's runtime page lists.
`admin` signs in to Platform and to Studio as an admin, and `user` signs in to Studio only.
The realm's user manager, or the site's own identity team for an external Keycloak, assigns them.
The first LibreDB admin holds no Keycloak management role, because an account that can manage users can give `libredb:admin` to anyone.

## Assign a role directly or through a group

Give a user `libredb:admin` or `libredb:user` in one of two ways:

- directly, in the user's role mapping, with the client `libredb` selected;
- through a group that holds the client role, at any depth of subgroups.

Both reach the claim, and Platform's directory sync and the user picker of the grant dialog list the user.

## Composite-only assignments are unsupported

A user who reaches `libredb:admin` or `libredb:user` only through a composite role, such as a realm role that includes the client role, is not supported.
Keycloak's token mapper expands composite roles, so such a user signs in and gets the role in `libredb_roles`.
Platform, however, reads the role's members through the Admin API: the users that hold the role directly and the members of the groups that hold it.
That listing never expands composite roles, so the user is missing from directory sync, from the Studio users page and from the user picker of the grant dialog: no admin can grant them a connection, and a removal of the composite role is not seen until the user's own Platform session is rechecked.
Keycloak offers no Admin API query that lists the effective members of a client role across composites without reading every user, which a large federated realm cannot afford on every sync.
Assign the role directly or through a group instead.

## Realm settings the installer keeps

In the realm of a managed Keycloak, the installer keeps brute force detection, a password policy and saved login and admin events, as the realm settings row of the [installer reference](../../README.md#docker-install) lists them, and every `apply` sets them back after a change in the console.
A reused realm of an external Keycloak keeps the settings that the site's identity team gives it.

## Lift a lockout

Brute force detection in the realm of a managed Keycloak locks an account in two ways, as the realm settings row of the [installer reference](../../README.md#docker-install) describes:

- for a while, after failed sign-ins: 1 minute after 5 of them, a minute more after every further 5, and at most 15 minutes;
- for good, after more than 100 wrong OTP codes that followed the account's correct password, by disabling the account.

A locked account gets `Invalid username or password.` even for its correct password, the same message as for a wrong one, so the user cannot tell a lockout from a typing error, and the realm console shows it.
The user manager lifts either kind in the realm console that `keycloak console` opens: under Users, the list marks the account `Temporarily locked`, and turning off `Temporarily locked` on the account's Details tab unlocks it, and enables it again when it was locked for good.
`Unlock all users`, in the menu beside Add user, ends every lock for a while at once, but an account locked for good stays disabled without the lock mark: turn on the `Enabled` switch at the top of its page.
A lock for a while also ends by itself.

The first admin holds no `realm-management` role, so it cannot lift a lockout.
When the user manager itself is locked out and no other account of the realm holds `manage-users`, root on the install host lifts the lock as the `libredb-installer` client of the [installer client runbook](installer-client.md).
The command below sends the request that the `Temporarily locked` switch sends, `PUT /admin/realms/<realm>/users/<id>` with `{"enabled": true}`, which ends a lock of either kind and clears the account's failed sign-ins.
It needs `curl` and `python3` on the host; set `LIBREDB_LOCKED_USER` for an account other than `libredb-user-manager`, and `LIBREDB_REALM` and `LIBREDB_KEYCLOAK_ADMIN_PORT` as the installer client runbook describes:

```sh
(
set -eu
. /opt/libredb/secrets/installer.env
realm="${LIBREDB_REALM:-libredb}"
keycloak="http://127.0.0.1:${LIBREDB_KEYCLOAK_ADMIN_PORT:-18080}"
username="${LIBREDB_LOCKED_USER:-libredb-user-manager}"
token=$(printf '%s' "$KEYCLOAK_INSTALLER_CLIENT_SECRET" | curl -fsS --data-urlencode grant_type=client_credentials --data-urlencode "client_id=$KEYCLOAK_INSTALLER_CLIENT_ID" --data-urlencode client_secret@- "$keycloak/realms/$realm/protocol/openid-connect/token" | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
id=$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -G -H @- --data-urlencode "username=$username" --data-urlencode exact=true "$keycloak/admin/realms/$realm/users" | python3 -c 'import json, sys; users = json.load(sys.stdin); print(users[0]["id"]) if users else sys.exit(f"realm {sys.argv[1]} has no user {sys.argv[2]}")' "$realm" "$username")
printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X PUT -H @- -H 'Content-Type: application/json' --data '{"enabled": true}' "$keycloak/admin/realms/$realm/users/$id"
echo "Unlocked $username"
)
```

The request also enables an account that someone disabled on purpose, so name only an account that is locked out.

## Leave Revoke Refresh Token off

The realm setting Revoke Refresh Token (Realm settings, Tokens) is off by default, and LibreDB is tested with it off.
With it on, Keycloak 26.8.1 detaches the `libredb-platform` client session when a refresh token is used twice.
Platform spends each refresh token once, but only within one process and for 30 seconds, so a response that carries the new session cookie and never reaches the browser, such as one the browser cancelled, leaves the spent token in the cookie.
The session then ends at the realm's SSO Session Idle, and the admin signs in again.
Keep the setting off on the realm LibreDB uses, managed or the site's own.
