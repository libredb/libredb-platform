---
name: cut-release
description: Use when releasing libredb-platform - versioning Platform, tagging v<version> for the image, pinning the image for the installer and the Helm chart, tagging installer-v<version>, checking the published binary, chart, Helm repository, OCI artifact and Artifact Hub, or recovering a release run that failed or published partially.
disable-model-invocation: true
---

# Cut a libredb-platform release

## Overview

One release number covers three things: the Platform image, the installer binary and the Helm chart `charts/libredb-platform`.
They ship in two steps, because the installer and the chart pin the image by digest, and the digest exists only after the image is built:

```
PR "chore(release): version Platform <v>" -> merge -> tag v<v> on the merge commit
  -> docker-build-push.yml builds ghcr.io/libredb/libredb-platform:<v> (and <major>.<minor>, latest)
PR "release: pin LibreDB Platform <v> for installer and chart <v>" -> all checks green -> merge
  -> tag installer-v<v> on the merge commit
     -> installer-release.yml: build (checks, binary, chart) -> publish (attest, immutable GitHub release, Latest)
        -> chart-index (index.yaml on gh-pages)   -> chart-oci (oci://ghcr.io/libredb/charts + Artifact Hub metadata)
  -> check every published artifact (Phase 5)
```

Rules that every phase depends on:

1. **Releases and tags here are immutable.**
   A published release never gets a missing asset, and the repository's tag rules refuse to delete or move a pushed tag.
   A tag whose run failed, even one that published nothing, therefore stays as it is, and the release moves to the next patch version: `installer-v1.1.0` failed in its build job and the release became 1.1.1.
2. **The release number names the installer and the chart.**
   `installer/package.json`, `version` of `installer/release/release.config.json` and `version` and `appVersion` of `charts/libredb-platform/Chart.yaml` are always equal; `installer/test/unit/kubernetes/chart.test.ts` and `installer-release.yml` refuse a mismatch.
   The Platform image keeps its own version (`package.json`, `images.platform.version`, `values.yaml`'s `platform.image.tag`): equal to the release when the release brings a new Platform, older when only the installer or the chart changed, as release 1.1.1 pins Platform 1.1.0.
3. **Tags carry a `v`**: `v1.1.0` for Platform, `installer-v1.1.1` for the installer and the chart.
4. **A green chain is not a working release.**
   Phase 5 downloads what was published and runs it.

## Phase 1 - Version Platform

Open a PR from a branch, never push to `main` directly.

```bash
npm version <v> --no-git-tag-version      # package.json and package-lock.json, the only way the lockfile changes
# README.md "Platform <v> is the current release" sentence, by hand
```

Choose the number by what changed since the last tag (`git log v<previous>..origin/main`): a new feature or API is a minor, fixes alone a patch.
Wait for every check of the PR, the `Docker end-to-end tests` of `Installer E2E` included, which takes about an hour.

## Phase 2 - Tag the image

```bash
git fetch origin main --tags
git tag -a v<v> -m "LibreDB Platform <v>" <merge commit of the Phase 1 PR>
git push origin v<v>
gh run watch <Docker Build & Push run of v<v>>
docker buildx imagetools inspect ghcr.io/libredb/libredb-platform:<v>   # the index digest, which the installer pins
```

Pin the **index** digest (`Digest:` of the first lines), as every earlier release does, never one platform's manifest.
A release that keeps the previous Platform skips Phases 1 and 2.

## Phase 3 - Pin the installer and the chart

On a branch from `origin/main`:

1. `installer/release/release.config.json`: `version`, and `images.platform` (`version`, `digest`) for a new Platform.
   Keep the file's formatting: `jq` rewrites `[1]` as a block, so edit by hand or restore it.
2. `installer/package.json` `version`, and the expected Platform version in `installer/test/unit/release/manifest.test.ts`.
3. `charts/libredb-platform/Chart.yaml`: `version`, `appVersion`, the Platform line of `artifacthub.io/images`, and a hand-written `artifacthub.io/changes` for this version.
   Each change is one double-quoted line: Artifact Hub skips a version for good over an unquoted `{}:[],&*#?|-<>=!%@`.
   Check `description` and `keywords` while the version moves anyway: a later fix to them costs a chart version of its own.
4. `charts/libredb-platform/values.yaml` `platform.image.tag` as `<v>@<digest>`.
5. The release names in `docs/deploy/install-docker.md` (title line, `V=`, the expected `version` output, the `cd ~/libredb-<v>` line), `docs/deploy/install-kubernetes.md`, `CLAUDE.md` (Installer section) and any "This release pins Platform" sentence of `installer/README.md`.
6. In `installer/`:

```bash
bun install --frozen-lockfile
bun run release:check          # contracts, the Studio pin against STUDIO_TAG and the registry, the Platform digest
bun run release:record         # writes release/history/<v>.json, which installer-release.yml requires
bun run build:helm-jobs        # the chart's jobs bundle embeds the manifest, so it is stale until rebuilt
bun run typecheck
bun run embed                  # the chart tests in coverage:check render with the Studio chart it downloads
bun run coverage:check && bun run build && ./dist/libredb-installer-linux-x64 version
```

Then in the repository root: `npm run lint`, `npm run typecheck`, `npm test`.
`scripts/ci/workflows.test.ts` checks the release workflow itself, so a workflow change without its test fails here and not in `installer/`.

Open the PR with `Closes` for the issues the release resolves, and wait for every check, the hour-long Docker end-to-end tests included.

## Phase 4 - Tag the installer and the chart

```bash
git fetch origin main --tags
git tag -a installer-v<v> -m "LibreDB installer <v>" <merge commit of the Phase 3 PR>
git push origin installer-v<v>
gh run watch <Installer Release run>
```

Count the jobs by name: `build`, `publish`, `chart-index`, `chart-oci` must all be green.
`build` refuses a tag whose version differs from `release.config.json`, `package.json` or `Chart.yaml`, and a missing `release/history/<v>.json`.

## Phase 5 - Check what was published

Run it in a scratch directory with a Helm configuration of its own, so no local repository or login hides a problem a user would hit:

```bash
V=<v>; B=https://github.com/libredb/libredb-platform/releases/download/installer-v$V
export HELM_REPOSITORY_CONFIG=$PWD/helm/repos.yaml HELM_CACHE_HOME=$PWD/helm/home HELM_REGISTRY_CONFIG=$PWD/helm/registry.json
gh release view installer-v$V --json isDraft,assets      # not a draft; the binary, LICENSE, the chart and SHA256SUMS
gh release list -L 3                                     # installer-v<v> is Latest
curl -fsSL -O "$B/libredb-installer-linux-x64" -O "$B/SHA256SUMS" -O "$B/LICENSE" -O "$B/libredb-platform-$V.tgz"
sha256sum -c SHA256SUMS
for f in libredb-installer-linux-x64 libredb-platform-$V.tgz SHA256SUMS; do gh attestation verify $f --repo libredb/libredb-platform; done
chmod 0755 libredb-installer-linux-x64 && ./libredb-installer-linux-x64 version      # release <v>

helm repo add libredb-platform https://libredb.org/libredb-platform/
helm search repo libredb-platform/libredb-platform --versions                       # <v>, app version <v>
mkdir -p repo oci                                                                   # helm pull -d needs the directory
helm pull libredb-platform/libredb-platform --version $V -d repo
helm pull oci://ghcr.io/libredb/charts/libredb-platform --version $V -d oci         # anonymous: the package is public
sha256sum repo/*.tgz oci/*.tgz libredb-platform-$V.tgz                              # all three equal
helm template t repo/libredb-platform-$V.tgz -n libredb \
  -f <checkout>/charts/libredb-platform/tests/e2e/values-kind.yaml --set platform.license.value=<any well-formed token>
```

The render must list the five pinned images, each with its digest.

- GHCR: the package `libredb/charts/libredb-platform` must be **public**: `curl -s -o /dev/null -w "%{http_code}" "https://ghcr.io/token?scope=repository:libredb/charts/libredb-platform:pull&service=ghcr.io"` answers 200.
  A package the workflow creates for the first time may start private, and only its settings page changes that.
- The OCI repository's Artifact Hub metadata is the tag `artifacthub.io` of that package, with the media types `application/vnd.cncf.artifacthub.config.v1+yaml` and `application/vnd.cncf.artifacthub.repository-metadata.layer.v1.yaml`.
- Artifact Hub polls each repository about every 30 minutes, so the new version appears up to an hour later.
  `curl -s "https://artifacthub.io/api/v1/repositories/search?org=libredb"` shows `verified_publisher` and `last_tracking_errors` of `libredb-platform` and `libredb-platform-oci`; an error that predates the release run, such as `DENIED` from before the first push, clears on the next poll.
  `curl -s https://artifacthub.io/api/v1/packages/helm/libredb-platform/libredb-platform` must show version `<v>`, the five images and the changes.
- Install the release on a clean host with the Docker install guide, and on a cluster with the chart's `tests/e2e/run-e2e.sh`, before announcing it.

## Recovery

| Failure | What to do |
|---|---|
| `build` fails | Nothing is published, but the tag cannot be deleted or moved. Fix on `main` through a PR, then cut the next patch version: Phase 3 again with only the release number (`release.config.json` `version`, `installer/package.json`, `Chart.yaml` `version` and `appVersion`, the docs), keeping the Platform pin, and Phase 4 with the new tag |
| `publish` fails before `gh release create` | Nothing is published; re-run the failed jobs of the run |
| `chart-index` or `chart-oci` fails | The GitHub release exists and is immutable; re-run only the failed job (`gh run rerun <run> --failed`), which uses the same uploaded artifact |
| A published asset is wrong | Never re-tag a published release: version a patch and run every phase again |

## Traps

| Trap | What happens |
|---|---|
| Pinning the digest of one platform's manifest | `release:check` compares the index digest the registry reports and fails |
| Forgetting `release:record` | `installer-release.yml` stops before it builds: `release/history/<v>.json` does not exist |
| Forgetting `build:helm-jobs` after changing the manifest or installer code | `bundle.test.ts` fails in `coverage:check`, locally and in the release job |
| Running only `installer/` tests | `scripts/ci/workflows.test.ts` in the root suite checks the release workflow and fails CI |
| Trusting a local `coverage:check` for the release job | Locally `installer/generated/` and a Helm repository config usually exist; the release job starts without both. Before Phase 4 after any change to `installer-release.yml`, run its build steps in a clean worktree with `HELM_REPOSITORY_CONFIG` pointing at an empty file: the chart tests fail unless `bun run embed` ran first |
| A workflow change tested only by its PR | `installer-release.yml` runs on a tag alone, so no PR ever runs it; `scripts/ci/workflows.test.ts` and the clean-worktree run above are its only checks before a release |
| `artifacthub.io/changes` left from the previous version | Artifact Hub shows the old changelog for the new version, frozen once published |
| An unquoted special character in a change | Artifact Hub skips that chart version permanently |
| Calling the release done because the run is green | Nothing in the chain installs the published files; Phase 5 does |
| A Studio chart pinned as `git:<sha>` | `installer-release.yml` builds it from a Studio clone; a published chart must pin a released Studio chart |

## Red flags - stop and re-read this skill

- About to tag `installer-v<v>` before `ghcr.io/libredb/libredb-platform:<v>` exists
- About to tag a commit other than the merge commit of the pin PR
- About to push to `main` without a PR
- About to delete, move or re-upload a tag or a release that was already pushed
- About to declare the release done without downloading and running what was published
