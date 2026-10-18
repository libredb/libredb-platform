# CLAUDE.md: libredb-platform

> AI agent instructions for Claude Code and similar tools.

@AGENTS.md

## Project Overview

**libredb-platform** is a Database Access Governance platform that runs on-premise as a self-hosted install with one tenant, or multi-tenant in cloud mode.
It governs access to LibreDB Studio, the open-source database web editor, with authentication, RBAC, connection governance, audit logging and support tickets, and adds tenant management and billing in cloud mode.

**Two products:** Platform is the commercial product, source-available under the Elastic License 2.0 in `LICENSE`.
Studio is a separate open-source service with its own repository, image and deployment, and Platform links to it through `STUDIO_PUBLIC_URL` instead of embedding it.

## Repositories

- **Platform:** this repository, source-available under the Elastic License 2.0
- **Studio:** https://github.com/libredb/libredb-studio, the separate open-source repository

## Tech Stack

- Next.js 16 (App Router), React 19, TypeScript 5
- Tailwind CSS 4, shadcn/ui (base-nova style)
- Prisma 7.x with @prisma/adapter-pg, PostgreSQL 15 or newer (CI tests 15 and 18, and the compose files and the installer run 18)
- Auth.js v5 with the Credentials provider in cloud mode and Keycloak single sign-on alone in self-hosted mode (`src/shared/lib/identity/providers.ts`).
- TanStack Query v5, Zustand, nuqs, React Hook Form + Zod

## Architecture

**Feature-first vertical slices:**
```
app/ ──imports→ features/ ──imports→ shared/
```
- `app/` renders pages (Server Components), never exports to features
- `features/` are self-contained slices: **a feature CANNOT import another feature**
- `shared/` is the kernel and never imports any feature

**Key patterns:**
- Server Actions for mutations (`'use server'`), NOT API Routes
- API Routes only for: Auth.js, health checks, client-polled reads, file downloads and webhooks
- Repository pattern per feature (`{feature}.repository.ts`)
- `safeAction()` wrapper for all Server Actions (validation + auth + logging)
- Tenant isolation is a `tenantId` filter written in each repository query; there is no PostgreSQL row-level security, and no feature uses `createTenantClient` from `db.ts`.
- `proxy.ts` (NOT `middleware.ts`): Next.js 16 renamed middleware to proxy

## Development Commands

```bash
npm install              # Install deps (runs prisma generate via postinstall)
npm run dev              # Dev server (Turbopack)
npm run build            # Production build (Turbopack, standalone output)
npm run lint             # ESLint
npm run typecheck        # TypeScript check
npm test                 # Vitest unit tests
npm run test:db          # Database tests (*.db.test.ts) against PostgreSQL in Docker
npm run test:integration # Integration tests (*.integration.test.ts) against Keycloak in Docker
npm run test:e2e         # Playwright E2E tests

npm run db:setup         # Run migrations + seed
ALLOW_DB_RESET=1 npm run db:reset  # Development only: drop schemas bridge and platform, re-migrate, re-seed (DESTRUCTIVE)
npm run db:migration -- <name>  # Write a new migration from the changes in schema.prisma
npm run db:migrate       # Apply pending migrations (prisma migrate deploy)
npm run db:drift         # Fail when schema.prisma has changes no migration holds
npm run db:seed          # Run seed only
npm run db:studio        # Open Prisma Studio
```

## Database

One PostgreSQL database `libredb` holds three schemas:

| Schema | Owner | Contents |
|--------|-------|----------|
| `platform` | `libredb_owner` | Platform's Prisma tables and the migration history `platform._prisma_migrations` |
| `bridge` | `libredb_owner` | The contract objects Studio reads and writes, created by raw SQL in Prisma migrations |
| `studio` | `libredb_studio` | Studio's own storage; Platform never reads or touches it |

Two roles serve Platform, and the table of PostgreSQL roles in `docs/platform-studio-integration.md` lists what each role may touch.
`libredb_owner` runs every migration through `MIGRATE_DATABASE_URL`, which only the Prisma CLI reads (`prisma.config.ts`), and is never used by a long-running process.
`libredb_platform` is the runtime role behind `DATABASE_URL`: DML on the platform tables through the default privileges of the baseline migration, and no DDL.
`schema.prisma` lists only `schemas = ["platform"]`, so every new model and enum carries `@@schema("platform")`, and Prisma never diffs schema `bridge`.
There is no `db:push`: it acts on the whole schema, so every schema change is a migration.

Migration workflow:
`npm run db:migration -- <name>` creates a migration: it writes the changes of `prisma/schema.prisma` that no migration holds into `prisma/migrations/<timestamp>_<name>/migration.sql` (`prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`) and applies nothing.
Raw SQL added to a migration by hand names its schema, such as `platform.users` or `bridge.query_events`.
`npm run db:migrate` applies the pending migrations with `prisma migrate deploy`.
Applied migrations are never edited, because every database records their checksums in `platform._prisma_migrations`.
Do not use `prisma migrate dev`: Prisma resets only the schemas listed in `schemas` of its shadow database, schema `bridge` and its functions survive there, and the next replay fails with P3006.
`npm run db:migration` and `npm run db:drift` therefore first run `scripts/prisma-shadow-reset.ts`, which drops every schema except `public` in the database of `SHADOW_DATABASE_URL` as `libredb_owner`, and refuses a database that holds a Prisma migration history.
The CI `db-tests` job runs `npm run db:drift`, which fails when `prisma/schema.prisma` has changes no migration holds.

Development uses `database-compose.yml`, which applies the same bootstrap as the tests (`docker/postgres/bootstrap.psql`) with development passwords and creates the shadow database `libredb_shadow`.
`.env.example` holds the matching `DATABASE_URL`, `MIGRATE_DATABASE_URL` and `SHADOW_DATABASE_URL`.
`npm run db:reset` (`scripts/dev/db-reset.mjs`) is for development only.
It refuses to run unless `ALLOW_DB_RESET=1` is set in the shell, drops the schemas `bridge` and `platform` as `libredb_owner`, never touches schema `studio`, and then runs `prisma migrate deploy` and the seed.

## Bridge migrations

Schema `bridge` holds the contract objects that Studio reads and writes, which Studio's `GOVERNANCE.md` (vendored at `tests/fixtures/governance/GOVERNANCE.md`) specifies with the privileges of each role.
Its objects live only in raw SQL blocks of Prisma migrations under `prisma/migrations/`.
Schema `bridge` is never listed in the `schemas` of `prisma/schema.prisma`, so Prisma never diffs it.
Every migration that touches `bridge` starts with `SET lock_timeout = '5s';`, so it cannot queue Studio's reads behind a long lock.
A migration that drops a bridge view and re-creates it grants on that view again in the same file, after the `CREATE VIEW`, because `DROP VIEW` loses the view's grants.
`CREATE OR REPLACE VIEW` keeps grants, so prefer it whenever the change allows it.
`checkBridgeMigration` in `prisma/migration-rules.ts` checks the lock timeout and re-grant rules, and `prisma/migration-rules.test.ts` runs it over every migration, so `npm test` fails on a violating migration.

## Studio

Studio runs as a separate service, and Platform neither depends on it, imports it nor bundles its styles.
`src/shared/lib/no-embedded-studio.test.ts` fails when the Studio package appears in Platform's dependencies, configuration, CI or any file under `src`.
The sidebar's `STUDIO` menu item has no stored URL: `resolveMenuLinks` in `src/shared/lib/menu-links.ts` resolves it from `STUDIO_PUBLIC_URL` and the sidebar opens it in a new tab.
A Studio change therefore needs no step in this repository; run Studio from its own repository and point `STUDIO_PUBLIC_URL` at it.

Platform vendors Studio's governance contract under `tests/fixtures/governance/`: `GOVERNANCE.md`, `contract-v1.json` and `lsb1-vectors.json`, each with a `.sha256` pin, and the Studio build in `STUDIO_TAG`.
`node scripts/vendor-studio-governance.mjs <tag>` is the only way these files change, and nobody edits them by hand.
It takes a Studio release tag as Studio publishes it, bare semver such as `1.2.3` or a `v` tag such as `v1.2.3`, which it downloads from GitHub and records in `STUDIO_TAG` as given, or `git:<ref>` with `STUDIO_REPO` set to a local Studio clone, which it records as `git:<full sha>`.
`tests/fixtures/governance/vendored.test.ts` checks every pin, the tag and the manifest sections Platform consumes.
`tests/db/contract-conformance.db.test.ts` checks a freshly migrated database against that manifest: every bridge object with its column types, nullability, CHECKs and grants, every closed vocabulary, the notification kinds, the settings allowlist, and every Studio statement run as `libredb_studio`, so `npm run test:db` fails on a bridge change that drifts from the pinned Studio build.

## Licensing

Every self-hosted install needs a license key, which it reads from `PLATFORM_LICENSE`: the runtime configuration refuses self-hosted mode without it, and `docs/deploy/platform-runtime.md` describes the license states, how seats are counted and what each gate refuses.
The license module lives in `src/shared/lib/license/`: the token format and its verification, the license state, the seat counts and the gates.
A token that fails verification puts the install in state `invalid`, which grants no seat: every gate refuses an addition with `LICENSE_INVALID`, and existing access keeps working.
`keys.ts` holds only the public keys that verify a license, and no real private key belongs anywhere in this repository.
Tests sign their tokens with the keys of `tests/license/test-keys.ts`, which derive from published labels marked test only, and `keys.test.ts` fails when one of them joins `keys.ts`.
A test that only needs a working install takes the active license of 1 admin seat and 3 user seats from `tests/license/statuses.ts`.
The gates run only in self-hosted mode: in cloud mode `getLicenseStatus()` returns null, and no gate locks or counts.
Never print a license token, a private key or a key seed, in a log line, an error, a test name or any other output: the logger redacts context fields by name, such as `PLATFORM_LICENSE`, and never a token inside a message.

## Key Files

| File | Purpose |
|------|---------|
| `src/proxy.ts` | Auth + tenant resolution (NOT middleware.ts) |
| `src/shared/lib/auth.ts` | Auth.js v5 config |
| `src/shared/lib/db.ts` | Prisma client + tenant extensions |
| `src/shared/lib/menu-links.ts` | Resolves external menu links such as Studio from the runtime configuration |
| `src/shared/lib/safe-action.ts` | Server Action wrapper |
| `src/shared/lib/permissions.ts` | RBAC constants: six system roles (three platform, three tenant) and the permission codes |
| `src/shared/lib/feature-flags.ts` | DB-backed plan limits |
| `src/shared/lib/logger.ts` | Structured JSON logger |
| `prisma/schema.prisma` | 36 models |
| `prisma/seeds/production.ts` | System data seed |
| `prisma/seeds/development.ts` | Fake data seed |

## Environment Variables

See `.env.example` for the full list.
`docs/deploy/platform-runtime.md` holds the runtime inventory of a self-hosted install, the migrate container's environment, the image commands and the operator runbooks; `src/shared/lib/runtime-config.docs.test.ts` fails when a variable of the runtime schema is missing from it.
Platform checks its runtime configuration when the Node.js server starts: `register()` in `src/instrumentation.ts` runs `readRuntimeConfig(process.env)` from `src/shared/lib/runtime-config.ts` through `src/instrumentation-node.ts`.
A missing or invalid variable stops `npm run dev`, `npm start` and the container with one `ConfigError` that names every such variable and never prints a value.
An empty value counts as unset.
`next build` never calls `register()`, so the build needs only the placeholder `AUTH_SECRET` that the Dockerfile sets.
`getRuntimeConfig()` returns the checked values, and `getDeploymentMode()` and `isSelfHosted()` in `src/shared/lib/deployment.ts` read the mode.
A new variable joins the schema in `runtime-config.ts` with a failing test first.
Next.js also compiles `src/instrumentation.ts` for the Edge runtime, so Node.js-only startup code belongs in `src/instrumentation-node.ts`.

- `DEPLOYMENT_MODE`: required, `cloud` or `self-hosted`, with no default.
- `DATABASE_URL`: required, a `postgresql://` URL that includes `schema=platform`.
- `AUTH_SECRET`: required, at least 32 characters.
- `AUTH_URL`: the absolute http(s) URL of Platform, required when `NODE_ENV` is `production`, which `npm start` and the Docker image set.
- `STUDIO_PUBLIC_URL`: the absolute http(s) URL of Studio, required in self-hosted mode; in cloud mode, leaving it unset hides the sidebar's Studio link.
- `PLATFORM_LICENSE`: the license token, required in self-hosted mode; a token that fails verification never stops the start, and cloud mode ignores the variable.
- `SEED_MODE`: `production` or `development`, read by the seed only.
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`: read by the production seed only, which creates the first platform admin of a cloud install once when both are set and stops with a `ConfigError` when only one is.
  No default password exists anywhere, and a later seed run never changes that admin or its password hash.
- `SEED_USER_PASSWORD`: required by the development seed, the password of every user it creates.

## Testing

- Unit tests: `src/**/*.test.ts` (colocated)
- Database tests: `**/*.db.test.ts` run against a real PostgreSQL with `npm run test:db`, never with `npm test`.
  The script starts `docker-compose.test.yml` (PostgreSQL `${TEST_POSTGRES_MAJOR:-18}` on host port `${TEST_POSTGRES_PORT:-55432}`, tmpfs storage) and runs `vitest.db.config.ts`.
  `docker-compose.test.yml` names its compose project `libredb-platform-test`, so it never shares a container with the development database of `database-compose.yml`, and `scripts/ci/compose-projects.test.ts` keeps it so; a parallel run from another checkout sets `COMPOSE_PROJECT_NAME`.
  The container applies `docker/postgres/bootstrap.psql`, the database bootstrap that `docs/deploy/platform-runtime.md` describes, with development passwords and creates the shadow database `libredb_shadow`.
  Open clients with `tests/db/connect.ts`, assert SQLSTATE codes with `tests/db/sqlstate.ts`, and collect the notifications on `libredb_bridge` with `tests/db/listen.ts`.
- Integration tests: `**/*.integration.test.ts` run against real Keycloak with `npm run test:integration`, never with `npm test`.
  Start the servers first with `docker compose -f docker-compose.test.yml up -d --wait keycloak keycloak-proxied`.
  Both run Keycloak 26.8.1, the version the installer ships, and import `tests/fixtures/keycloak/libredb-test-realm.json`, which mirrors the realm the installer converges, as the Keycloak contract of `docs/deploy/platform-runtime.md` describes it.
  `keycloak` serves the issuer `http://localhost:${TEST_KEYCLOAK_PORT:-58080}/realms/libredb`.
  `keycloak-proxied` has the managed-Keycloak hostname settings: issuer `https://auth.libredb.test/realms/libredb` and the admin URL on `127.0.0.1:${TEST_KEYCLOAK_PROXIED_PORT:-58081}`.
  The realm users alice (admin), grace (admin through group `dba`), bob (user), dave (user through `analysts`), erin (user through `analysts/juniors`), frank (user, disabled) and carol (no role) share the password `libredb-test-password`.
  Get real tokens with `tests/keycloak/helpers/code-login.ts`, which signs in through Keycloak's login form with PKCE.
- E2E tests: `e2e/*.spec.ts` (Playwright)
  The cloud specs read `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` (the bootstrap admin) and `E2E_USER_PASSWORD` (the development seed's `SEED_USER_PASSWORD`) through `e2e/credentials.ts`.
  The self-hosted specs need `PLATFORM_LICENSE` in the environment of the server and of the Playwright run: a license whose hosts include `localhost`, with 1 admin seat and 3 user seats.
  `e2e/self-hosted/platform.env` holds no license, and CI takes it from the repository secret `LIBREDB_E2E_LICENSE`.
- Login credentials (dev): the bootstrap admin and the development seed's users, see `.env.example`

## Installer

`installer/` is a standalone Bun 1.4.2 package with its own `package.json`, `bun.lock` and tests.
Platform's lint, Vitest run and Docker image ignore it.
Release 1.0.1 installs in Docker mode on one x86_64 Linux host: the configuration schema already accepts `mode: kubernetes`, but `preflight`, `plan`, `apply`, `verify` and `db-script` refuse it until Kubernetes mode arrives in the next release.
`docs/deploy/install-docker.md` is the customer's install guide and `installer/README.md` the reference of every command and field, so a change to a command, a default or a prerequisite updates both.

```bash
cd installer
bun install --frozen-lockfile   # Install deps
bun run typecheck               # TypeScript check
bun run test                    # Unit tests (test/unit)
bun run coverage:check          # Unit tests + 100% line gate on pure modules under src/
bun run test:int                # Integration tests (test/integration, against a Docker host)
bun run test:e2e                # End-to-end tests (test/e2e)
bun run build                   # dist/libredb-installer-linux-x64
```

Code under `src/adapters/`, `src/steps/` and `src/cli/` only wires pure modules to the host and is covered by the integration and end-to-end tests; every other file under `src/` needs 100% line coverage from the unit tests.
