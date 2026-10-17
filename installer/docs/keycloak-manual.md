# Configuring the Keycloak realm by hand

This guide is for a site whose identity team configures its own Keycloak realm for LibreDB and shares only two client secrets with the installer (`keycloak.external.provisioning: manual`, as [the installer's README](../README.md#a-realm-the-site-configures-itself) describes).
It creates the same objects as the installer's export, `libredb-installer keycloak export -c libredb.yaml -o <dir>`, through the Keycloak 26 admin console instead of JSON.
The installer never receives a Keycloak admin credential in this mode.
It checks the realm from outside with the two client secrets on every `apply`, and stops with exit 3 naming each difference it finds.

Replace the placeholders below with the values of your `libredb.yaml`:

| Placeholder | Value |
| --- | --- |
| `<realm>` | `keycloak.realm`, an existing realm |
| `<studio>` | `endpoints.hosts.studio` |
| `<platform>` | `endpoints.hosts.platform` |
| `<auth>` | `endpoints.hosts.auth`, the host of `keycloak.external.baseUrl` |

The export file lists the exact redirect and post-logout URIs for your configuration, so compare against it when in doubt.
Open the admin console of your Keycloak, sign in as an administrator of `<realm>`, and select `<realm>` in the realm list.

## 1. Client `libredb`, the role holder

1. Open Clients, then Create client.
2. Keep Client type OpenID Connect, set Client ID to `libredb` and Name to `LibreDB roles`, then Next.
3. Turn Client authentication on.
4. Under Authentication flow, turn every option off: Standard flow, Direct access grants, Implicit flow, Service accounts roles, OAuth 2.0 Device Authorization Grant, OIDC CIBA Grant and Standard Token Exchange.
5. Next, then Save.
6. Open the Roles tab and create the role `admin` with the description `LibreDB administrator`.
7. Create the role `user` with the description `LibreDB user`.

No flow is enabled and no secret of this client is ever used: it only holds the two roles.

## 2. Client scope `libredb-roles`

1. Open Client scopes, then Create client scope.
2. Set Name to `libredb-roles`, Type to None and Protocol to OpenID Connect.
3. Turn Display on consent screen off and Include in token scope off, then Save.
4. Open the Mappers tab, choose Configure a new mapper, then User Client Role.
5. Set Name to `libredb roles`, Client ID to `libredb`, and leave Client Role prefix empty.
6. Turn Multivalued on, set Token Claim Name to `libredb_roles` and Claim JSON Type to String.
7. Turn Add to ID token, Add to access token, Add to userinfo and Add to token introspection on, then Save.
8. Open the Scope tab, choose Assign role, filter by clients, select `libredb` `admin` and `libredb` `user`, and Assign.

The scope must carry only this mapper, because every claim it adds reaches both apps.
The scope mapping keeps the roles in the token when Full scope allowed is off on an app client.

## 3. Client `libredb-studio`

1. Open Clients, then Create client.
2. Set Client ID to `libredb-studio` and Name to `LibreDB Studio`, then Next.
3. Turn Client authentication on, keep Standard flow on, and turn every other flow off, Service accounts roles included.
4. Next, set Valid redirect URIs to exactly `https://<studio>/api/auth/oidc/callback` and Valid post logout redirect URIs to `https://<studio>/login`, then Save.
5. Open the Advanced tab, and under Advanced settings set Proof Key for Code Exchange Code Challenge Method to S256, then Save.
6. Open the Client scopes tab, choose Add client scope, select `libredb-roles` and add it as Default.
7. Open the Credentials tab and copy the Client Secret.

## 4. Client `libredb-platform`

1. Open Clients, then Create client.
2. Set Client ID to `libredb-platform` and Name to `LibreDB Platform`, then Next.
3. Turn Client authentication on, keep Standard flow on, turn Service accounts roles on, and turn every other flow off.
4. Next, set Valid redirect URIs to exactly `https://<platform>/api/auth/callback/keycloak` and Valid post logout redirect URIs to `https://<platform>/login`, then Save.
5. Open the Advanced tab, and under Advanced settings set Proof Key for Code Exchange Code Challenge Method to S256, then Save.
6. On the same tab, under OpenID Connect Compatibility Modes, keep Use refresh tokens on, then Save.
   Platform keeps its Keycloak session alive with the refresh token and refuses a sign-in without one.
7. Open the Client scopes tab, choose Add client scope, select `libredb-roles` and add it as Default.
   Keep the realm's default scopes, `email` among them, which Platform's sign-in needs.
8. Open the Service accounts roles tab, choose Assign role, filter by clients, select `realm-management` `view-users` and `realm-management` `view-clients`, and Assign.
9. If Full scope allowed is off for this client (Client scopes tab, `libredb-platform-dedicated`, Scope tab), assign the same two roles there too.
10. Open the Credentials tab and copy the Client Secret.

Give the service account only these two `realm-management` roles.
Without them Platform's session recheck, directory sync and grant search fail, and every Platform session ends when the recheck grace runs out.

Neither app client may carry a pairwise subject identifier mapper, because both apps key every user by the `sub` claim.

## 5. Users

Users and their role assignments stay with the identity team.
Give each LibreDB user the client role `admin` or `user` of client `libredb`, directly (Users, the user, Role mapping, Assign role, filter by clients) or through a group.
A role reached only through a composite role is not seen by Platform's directory sync and is not supported.

## 6. The installer

Store the two secrets in files that only root can read, or in environment variables of the installer, and set them in `libredb.yaml`:

```yaml
keycloak:
  mode: external
  realm: <realm>
  external:
    baseUrl: https://<auth>
    provisioning: manual
    studioClientSecretFile: /root/libredb-studio-client-secret
    platformClientSecretFile: /root/libredb-platform-client-secret
```

Then run `apply`.
When a check fails, the installer names each finding, such as a missing role or a redirect URI that differs, and exits 3; fix the realm and run `apply` again.
When you regenerate a client secret later, update its file or variable and run `apply`, which stores the new secret and restarts the app that uses it.
