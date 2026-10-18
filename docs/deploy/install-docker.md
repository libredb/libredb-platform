# Install LibreDB with Docker

This guide installs LibreDB 1.0.0 on one x86_64 Linux host with Docker.
The installer, `libredb-installer`, runs on that host as root and deploys PostgreSQL, Keycloak, LibreDB Platform, LibreDB Studio and a Caddy edge as the Docker Compose project `libredb`.
The guide takes the shortest path: a PostgreSQL and a Keycloak that the installer runs itself, one DNS name per app, and certificates from the installer's internal CA.
The [installer reference](../../installer/README.md) covers the other choices: your own certificates or TLS proxy, an existing PostgreSQL server or Keycloak realm, one host without DNS, and a registry mirror.
Kubernetes support comes in the next release.

## What you need

- One x86_64 Linux host that runs systemd, on which the installer enables a timer that renews the certificates of its internal CA once a year; on a host without systemd, `apply` warns that nothing renews them.
- Docker Engine 28.0.0 or newer, except 28.2.0 through 28.3.2, which `preflight` refuses, and the Docker Compose plugin 2.24.0 or newer.
  Before 28.0.0, hosts on the same L2 segment can reach ports published to `127.0.0.1`, such as the managed Keycloak's admin port 18080, and from 28.2.0 to 28.3.2 a firewalld reload lets a host with a route to a Docker bridge network reach them (CVE-2025-54388).
  On an engine of that range, `preflight` names the advisory and asks for an upgrade to 28.3.3 or newer, which fixes it.
- `ss`, from iproute2, which `preflight` runs to find what holds a port, and without which it stops with exit 3.
- A root shell on the host.
- Port 443 free on the host and reachable from the users' browsers, and port 18080 free on `127.0.0.1`, where the managed Keycloak serves its admin API to the installer.
- Three DNS names, for Platform, Studio and Keycloak, such as `libredb.acme.example`, `studio.acme.example` and `sso.acme.example`, which the users' browsers resolve to the host.
  The host itself needs to resolve them only behind your own TLS proxy (`tls.mode: external`) or with an existing Keycloak.
- Outbound HTTPS from the Docker daemon to the registries of the pinned images: `ghcr.io` with `pkg-containers.githubusercontent.com` for Platform and Studio, `quay.io` with its download hosts such as `cdn01.quay.io` for Keycloak, and Docker Hub, which serves `docker.io` from `registry-1.docker.io`, `auth.docker.io` and download hosts such as `production.cloudfront.docker.com`, for PostgreSQL and Caddy.
  A site without that access sets `images.registry` to a registry mirror that holds the same images under the same digests, as the [installer reference](../../installer/README.md#usage) describes.
- Outbound HTTPS from the host to `github.com` and GitHub's release download host, such as `release-assets.githubusercontent.com`, for the [download of the installer](#download-and-verify-the-installer).
  Without that access, download and check the two files on another machine as that step shows, then copy them to the host.
- A license file, or none for the free tier of 1 admin seat and 3 user seats.

Run every command of this guide as root on the install host, for example in a shell that `sudo -i` opens.
These commands show the versions, the tools and any listener on the two ports:

```sh
uname -m
docker version --format '{{.Server.Version}}'
docker compose version --short
command -v ss systemctl
ss -Htln 'sport = :443'
ss -Htln 'sport = :18080'
```

Expected: `x86_64`, an engine version of 28.0.0 or newer outside 28.2.0 through 28.3.2, a Compose version of 2.24.0 or newer, a path for `ss` and for `systemctl`, and no line for either port.
`preflight` checks the versions and the ports again before anything is installed.

## Request a license

Skip this step to install on the free tier; a license can be installed later, as [Renew or change the license](#renew-or-change-the-license) shows.
Write to [info@libredb.org](mailto:info@libredb.org) with:

- the customer name that the license shows;
- the number of admin seats and of user seats;
- the expiry date;
- the Platform hostname, `endpoints.hosts.platform` of the configuration below, such as `libredb.acme.example`.

An admin seat is held by an admin who has signed in to Platform, and a user seat by a user who holds an unexpired grant on an active connection, as the [License section](platform-runtime.md#license) of Platform's runtime guide counts them.
A license that names hosts verifies only when Platform runs on one of them, so a later change of the Platform hostname needs a new license.

A LibreDB member issues the license and sends it to you as a file attached to an email.
The file holds one line, the license token, which starts with `ldl1.`.
Save the attachment as you receive it: do not open it in an editor that wraps or changes the line, and do not copy the token into another file.
The installer treats the token as a secret and never prints it, so keep the file as you keep other credentials.

## Download and verify the installer

The installer is one binary, published with a file of checksums on this repository's [GitHub releases](https://github.com/libredb/libredb-platform/releases):

```sh
V=1.0.0
B=https://github.com/libredb/libredb-platform/releases/download/installer-v$V
mkdir -p ~/libredb-$V && cd ~/libredb-$V
curl -fL -O "$B/libredb-installer-linux-x64" -O "$B/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS
chmod 0755 libredb-installer-linux-x64
./libredb-installer-linux-x64 version
```

Expected: `sha256sum` prints `libredb-installer-linux-x64: OK`, and `version` prints `release 1.0.0`.
`sha256sum -c` needs no account, and it shows that the download is complete and matches the release's checksums.
To check that this repository's release workflow built the binary, verify its attestation with the [GitHub CLI](https://cli.github.com), which needs a GitHub login (`gh auth login`):

```sh
gh attestation verify libredb-installer-linux-x64 --repo libredb/libredb-platform
```

The binary runs from this directory.
The first `apply` copies it to `/opt/libredb/bin/libredb-installer`, which the commands after that `apply` in this guide run.

## Save the license file

Copy the license file to the host, then put it at a permanent path that only root can read:

```sh
install -d -m 0700 -o root -g root /etc/libredb
install -m 0600 -o root -g root acme.license /etc/libredb/platform.license
```

`acme.license` stands for the file you received.
The path must name a regular file: a symbolic link or a directory there makes `plan` and `apply` stop with exit 2.
Keep the file at this path, because the installer records it and the yearly certificate renewal runs `apply` with it, which stops with exit 2 and renews no certificate when the file is gone.
Keep a copy with your backups, because the [backup runbook](../../installer/docs/runbooks/restore.md) does not save it.

## Write the configuration

```sh
cat > /etc/libredb/libredb.yaml <<'EOF'
apiVersion: install.libredb.org/v1
kind: LibreDBInstallation
metadata:
  name: acme
mode: docker
endpoints:
  hosts:
    platform: libredb.acme.example
    studio: studio.acme.example
    auth: sso.acme.example
platform:
  organizationName: Acme Corp
  licenseFile: /etc/libredb/platform.license
EOF
chmod 0600 /etc/libredb/libredb.yaml
```

| Field | Value |
| --- | --- |
| `metadata.name` | A lowercase name for this installation, such as `acme` |
| `endpoints.hosts` | The DNS names of Platform, Studio and Keycloak (`auth`); `platform` is the hostname of the license |
| `platform.organizationName` | Your organization's name, which the first `apply` gives the install's one tenant; a later change does not rename it |
| `platform.licenseFile` | The absolute path of the license file; leave the line out for the free tier |

Every other field keeps its default: `tls.mode: generated`, in which the installer's internal CA issues the certificates, a managed PostgreSQL and Keycloak, the Keycloak realm `libredb` with its admin port on `127.0.0.1:18080`, and the first accounts `libredb-admin` and `libredb-user-manager`.
An installation keeps `postgres.mode`, `keycloak.mode` and `keycloak.realm` for life, so a later run that changes one of them stops with exit 6: choose them before the first `apply`.
Write every path in the configuration as an absolute path, because the installer resolves a relative one against the directory it runs in.
The configuration never holds a secret or a license token itself, only the paths or environment variables that hold them, and `validate` refuses one written inline.

## Check the host and the configuration

```sh
cd ~/libredb-1.0.0
./libredb-installer-linux-x64 validate -c /etc/libredb/libredb.yaml
./libredb-installer-linux-x64 preflight -c /etc/libredb/libredb.yaml
./libredb-installer-linux-x64 plan -c /etc/libredb/libredb.yaml
```

- `validate` prints the configuration with every default filled in, or exits 2 naming each problem.
  It does not read the license file.
- `preflight` checks Linux, root, the Docker Engine and Compose versions, `ss` and the free ports, then prints `Preflight passed`, or exits 3 naming every problem.
  It creates `/opt/libredb` and writes its run log under `/opt/libredb/logs`, as `plan`, `apply` and `verify` do too, but installs nothing.
- `plan` prints every action that `apply` would take.
  It reads the license file and exits 2 when the file is missing, empty or holds anything but one license token, and it never prints the token.

## Install

```sh
./libredb-installer-linux-x64 apply -c /etc/libredb/libredb.yaml
```

`apply` prints the plan and asks you to type `yes`; a script passes `--yes` instead.
It pulls the five images by digest, generates the secrets into `/opt/libredb/secrets` and the internal CA into `/opt/libredb/tls`, and starts the edge, PostgreSQL and Keycloak.
It then configures the Keycloak realm and its two first accounts, runs Platform's database migration, starts Platform with the license, and starts Studio.
It also copies itself to `/opt/libredb/bin/libredb-installer` and enables `libredb-tls-renew.timer`, which renews the certificates once a year.

A full `apply` ends with every check of `verify` and a report.
The report prints the URLs of Platform, Studio and Keycloak, the CA bundle, the license, the files that hold the temporary passwords of the two first accounts, the next steps, and every failed check and warning, and it never prints a secret.
`apply` runs again safely: every step changes only what differs from the configuration, so after you fix the cause of a failure, run the same command again.

| Exit code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Runtime failure |
| 2 | Invalid usage or invalid configuration |
| 3 | Preflight failed |
| 4 | Verification failed |
| 5 | Another `apply` or `db-script` holds the run lock |
| 6 | Unsafe change refused |

## Check the license

Platform verifies the license when it starts and logs one line with the result, which never holds the token.
The check `platform-license` of `verify` reads that line, and the report of `apply` prints what it found:

```text
License: <license id> for <customer>, active, expires at <expiry>
```

Without a license file the line reads `License: none, so Platform runs on the free tier of 1 admin and 3 users`.
The check fails, and `apply` exits 4, when Platform refuses the token: the cause names the code, such as `LICENSE_HOST_MISMATCH` for a license that does not name the Platform hostname, or `LICENSE_UNKNOWN_KID` for a token that no key of this release signed, and the install then runs on the free tier.
Send that code, never the token, to [info@libredb.org](mailto:info@libredb.org).
The check also warns from 30 days before the expiry and in the 14-day grace period, and fails once the grace period has ended.

Platform's own line shows the same, with a message such as `License active`, `No license, running on the free tier` or `License invalid, running on the free tier` and its `code`:

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml logs --no-log-prefix platform | grep -i licen
```

After the first sign-in below, Admin, License (`/admin/license`) in Platform shows the state, the expiry and the seats in use.

## Trust the internal CA

With `tls.mode: generated` the internal CA issues the certificates that browsers see, so every browser and client that opens the three URLs must trust it:

```sh
/opt/libredb/bin/libredb-installer tls export-ca -o /root/libredb-ca.crt
```

`/root/libredb-ca.crt` holds the CA certificate without its key: add it to the trust store of each workstation whose browser opens the three URLs.
The CA carries no name constraints, so it can sign a certificate for any name, and its key sits on the install host: whoever controls the host can issue certificates for any site that every machine trusting the CA accepts.
Import it only on machines whose users trust the host's operators.
For an enterprise trust store, such as one that your device management distributes, prefer `tls.mode: provided` with certificates from your own CA, as the [installer reference](../../installer/README.md#docker-install) describes.
The CA is valid for 10 years, and the renewal timer issues new certificates from it, each valid for 825 days.
With your own certificates (`tls.mode: provided`) or TLS proxy (`tls.mode: external`), browsers trust your CA instead.

## Sign in for the first time

```sh
cat /opt/libredb/secrets/first-admin.txt
```

Open `https://libredb.acme.example`, choose Continue with SSO and sign in as `libredb-admin` with that temporary password.
Keycloak then asks for a new password, a TOTP device for the second factor, an email address and a name.
The realm's password policy asks for at least 15 characters, neither the username nor the email address, and none of the last 3 passwords.
After 5 failed sign-ins an account waits a minute before the next one, and further failures make it wait longer, up to 15 minutes.
More than 100 wrong OTP codes after the correct password disable the account until the user manager unlocks it, as [Keycloak roles](../../installer/docs/runbooks/keycloak-roles.md#lift-a-lockout) describes.
This account holds `libredb:admin` and takes one admin seat, which on the free tier is the only one.

The second account, `libredb-user-manager`, manages the users of the realm in Keycloak's console:

```sh
cat /opt/libredb/secrets/user-manager.txt
/opt/libredb/bin/libredb-installer keycloak console -c /etc/libredb/libredb.yaml
```

`keycloak console` prints the URL of the realm console, which listens only on the host's loopback interface, and the SSH tunnel that reaches it from a workstation; use your own SSH login in that command.
Sign in there as `libredb-user-manager`, which also sets a new password and a TOTP device, and create the users.
Give each one the role `admin` or `user` of client `libredb`, directly or through a group, as [Keycloak roles](../../installer/docs/runbooks/keycloak-roles.md) describes: `admin` signs in to Platform and Studio, and `user` signs in to Studio only.
Delete each temporary password file once its account has set its own password.

In Platform, an admin then adds a connection under Connections and grants users access to it.
A user opens Studio at `https://studio.acme.example` and signs in through Keycloak, and an admin also reaches Studio from Platform's sidebar.
The [acceptance checklist](../../installer/docs/ACCEPTANCE.md) signs off a new installation step by step.

## Operate the installation

The installer writes the Compose project `libredb` to `/opt/libredb/compose.yaml`, with the env files of the services under `/opt/libredb/env`.
[`installer/test/golden/compose-skeleton.yaml`](../../installer/test/golden/compose-skeleton.yaml) is an example of the file it writes, with placeholder image digests.
Every `apply` writes these files again, so change the configuration and run `apply` instead of editing them.

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml ps
docker compose -p libredb -f /opt/libredb/compose.yaml logs --tail 200 platform
docker compose -p libredb -f /opt/libredb/compose.yaml restart studio
/opt/libredb/bin/libredb-installer status
/opt/libredb/bin/libredb-installer verify -c /etc/libredb/libredb.yaml
```

The services are `edge`, `postgres`, `keycloak`, `platform` and `studio`, and `platform-migrate` is a one-shot job in the Compose profile `jobs`.
`status` prints each step's last result, the holder of the run lock, the health of every container and the days left of every certificate, and `verify` runs every check again.
Show the state of Platform's database migrations with that job, never with `docker exec`, because only the job's env file holds the URL of the migration role:

```sh
docker compose -p libredb -f /opt/libredb/compose.yaml --profile jobs run --rm platform-migrate migrate-status
```

The runbooks of a Docker install are [backup and restore](../../installer/docs/runbooks/restore.md), [secret rotation](../../installer/docs/runbooks/secret-rotation.md), [seal key rotation](../../installer/docs/runbooks/seal-key-rotation.md), [the `libredb-installer` client](../../installer/docs/runbooks/installer-client.md), [break-glass](../../installer/docs/runbooks/break-glass.md), [Keycloak roles](../../installer/docs/runbooks/keycloak-roles.md) and [upgrade](../../installer/docs/runbooks/upgrade.md).

## Renew or change the license

Request the new license as [Request a license](#request-a-license) describes, for the same Platform hostname, and put the new file at the same path:

```sh
install -m 0600 -o root -g root acme-renewed.license /etc/libredb/platform.license
/opt/libredb/bin/libredb-installer apply -c /etc/libredb/libredb.yaml
```

`apply` writes the new token into Platform's env file and recreates Platform; then check the license as [Check the license](#check-the-license) shows.
A free-tier install gets its first license the same way, after `platform.licenseFile` joins the configuration.
Admins see a banner from 30 days before the expiry, and a grace period of 14 days follows the expiry, in which the license's seats still apply.
After the grace period no new users, connections or admins can be added, while existing access and the audit log keep working.

## Upgrade

A later release comes as a new installer binary, whose release manifest pins the images of that release.
The [upgrade runbook](../../installer/docs/runbooks/upgrade.md) backs up the installation, verifies the new binary, and plans and applies the upgrade.
Downgrade and rollback are not supported.

## Get help

Report bugs and ask questions in [GitHub Issues](https://github.com/libredb/libredb-platform/issues), report a vulnerability as [SECURITY.md](../../SECURITY.md) describes, and write to [info@libredb.org](mailto:info@libredb.org) about licenses.
