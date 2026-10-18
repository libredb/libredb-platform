# Upgrade a Docker install

A later LibreDB release comes as a new installer binary, whose release manifest pins the images of that release by digest.
The upgrade runs that binary's `apply` against the installation: it pulls the new images, runs Platform's migration job, recreates every service whose image or settings changed, and replaces the installed copy `/opt/libredb/bin/libredb-installer`.
Downgrade and rollback are not supported: no command returns an installation to an earlier release, and the installer of an earlier release must never run against an installation that a later one applied.
A failed upgrade is fixed forward with the new installer.

Run every command as root on the install host.
`LIBREDB_CONFIG` names the configuration file you apply, for example `/etc/libredb/libredb.yaml`; `/opt/libredb/libredb.yaml` holds the configuration of the last `apply` if you no longer have yours.
Platform, Studio and the other services whose image changes restart during the upgrade, so plan it for a maintenance window.

An installation without `platform.licenseFile`, which release 1.0.0 allowed, needs a license before the upgrade, because the new installer refuses a configuration without it: `preflight`, `plan` and `apply` exit 2 and change nothing.
Request the license before the maintenance window as [Request a license](../../../docs/deploy/install-docker.md#request-a-license) describes, save it as [Save the license file](../../../docs/deploy/install-docker.md#save-the-license-file) shows, and add `platform.licenseFile` with its path to the configuration that `LIBREDB_CONFIG` names.

## 1. Back up

Take a backup set as [restore.md](restore.md#back-up) describes, and keep a copy of the license file and of the configuration with it.
The set recovers the data of the installation after a failure that `apply` cannot repair.

## 2. Download and verify the new installer

Set `V` to the version of the new release, the `X.Y.Z` of its tag `installer-vX.Y.Z`, then download and check its binary as the [install guide](../../../docs/deploy/install-docker.md#download-and-verify-the-installer) does:

```sh
B=https://github.com/libredb/libredb-platform/releases/download/installer-v$V
mkdir -p ~/libredb-$V && cd ~/libredb-$V
curl -fL -O "$B/libredb-installer-linux-x64" -O "$B/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS
chmod 0755 libredb-installer-linux-x64
./libredb-installer-linux-x64 version
```

Expected: `libredb-installer-linux-x64: OK`, and `version` prints `release` followed by the new release.
Read the notes of the new release before you go on.

## 3. Plan

```sh
./libredb-installer-linux-x64 preflight -c "$LIBREDB_CONFIG"
./libredb-installer-linux-x64 plan -c "$LIBREDB_CONFIG"
```

`preflight` checks the host against the minimums of the new release and the Docker Engine releases that the new installer refuses, such as 28.2.0 through 28.3.2.
`plan` prints what `apply` would change, such as the pulls of the new images, the update of `/opt/libredb/bin/libredb-installer`, the migration job and the services it recreates, and changes nothing.

## 4. Apply

```sh
./libredb-installer-linux-x64 apply -c "$LIBREDB_CONFIG"
```

Type `yes` at the prompt.
An installation that gives the installer the admin credential of an external PostgreSQL or Keycloak passes it through its `Env` or `File` reference, as on the first `apply`.
Platform's migration job runs before `apply` changes any Platform container; when the job fails, `apply` exits 1 with the job's log, and the running Platform stays as it was.
When Prisma reports a failed migration, the error also prints the `migrate-status` and `migrate-resolve` commands that repair the history, as the [P3009 recovery](../../../docs/deploy/platform-runtime.md#p3009-recovery) of Platform's runtime guide explains; fix the cause and run the same `apply` again.

## 5. Verify

```sh
/opt/libredb/bin/libredb-installer version
/opt/libredb/bin/libredb-installer verify -c "$LIBREDB_CONFIG"
docker compose -p libredb -f /opt/libredb/compose.yaml ps
```

Expected: the installed copy prints the new release, `verify` exits 0 because no check failed, and every service runs and is healthy.
From now on run `/opt/libredb/bin/libredb-installer`, which the yearly certificate renewal runs too, and delete the binaries of earlier releases, so that none of them runs against the installation again.
