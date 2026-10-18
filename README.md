# LibreDB Platform

**Database Access Governance Platform**, centralized, authorized, audited database access for teams and enterprises.

LibreDB Platform replaces distributing connection strings with a managed web interface where admins control who can access which databases, every query is logged, and teams collaborate securely.

## Features

- **Self-hosted**: One organization per install with Keycloak single sign-on; cloud mode, for development and a later hosted service, runs several tenants with isolated data and password sign-in
- **Database Connection Governance**: Credentials sealed to Studio's public key, connection grants per Keycloak user with the access panel
- **Studio link**: The sidebar opens [LibreDB Studio](https://github.com/libredb/libredb-studio), a separate service, at `STUDIO_PUBLIC_URL`
- **Query Audit Log**: Viewer for recorded queries with user, timing, and status; nothing records queries until Studio's query events arrive
- **RBAC**: Six system roles (Platform Admin, Platform Tech, Platform Support, Tenant Admin, Editor, Viewer) plus custom tenant roles
- **Support Tickets**: Built-in ticket system with message threads; in a self-hosted install the tickets stay inside the install and never reach LibreDB
- **Notifications**: In-app bell icon with real-time polling
- **Plans (cloud mode)**: Runtime-configurable plan tiers for cloud tenants; a self-hosted install is sized by its license key instead
- **LOV System**: Runtime-manageable dropdown values with i18n translations
- **Menu Authorization**: DB-backed, role-filtered sidebar navigation

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4, shadcn/ui |
| Auth | Auth.js v5 (Credentials in cloud mode, Keycloak single sign-on in self-hosted mode) |
| Database | PostgreSQL 15 or newer, Prisma 7.x |
| Query editor | [LibreDB Studio](https://github.com/libredb/libredb-studio), a separate service |
| Testing | Vitest + Playwright |

## Install

Platform 1.0.0 is the first release, published as the image `ghcr.io/libredb/libredb-platform`, and pairs with LibreDB Studio 1.0.0.
It installs with Docker on one x86_64 Linux host: the installer deploys PostgreSQL, Keycloak, Platform, Studio and a Caddy edge, and can use an existing PostgreSQL server or Keycloak instead.
Kubernetes support follows in the next release.
Cloud mode serves development and the hosted service of a later release, and it is not a supported way to install LibreDB.
Download the installer from this repository's [GitHub releases](https://github.com/libredb/libredb-platform/releases) and follow the [Docker install guide](docs/deploy/install-docker.md).
Every install needs a license key from LibreDB, and Platform does not start in self-hosted mode without one.
Write to [info@libredb.org](mailto:info@libredb.org) for a free license of 1 admin seat and 3 user seats for 12 months, as [License](#license) describes.

## Development setup

The steps below run Platform from source in cloud mode, with password sign-in and sample tenants.

### Prerequisites

- Node.js 24, the version CI and the image use
- PostgreSQL 15 or newer (or Docker, whose compose files run PostgreSQL 18)
- npm

### Setup

Clone this repository, then run these commands from its root:

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL, MIGRATE_DATABASE_URL, SHADOW_DATABASE_URL, AUTH_SECRET, DEPLOYMENT_MODE and STUDIO_PUBLIC_URL

# Start PostgreSQL (if using Docker): creates database libredb with the owner, runtime and Studio roles
docker compose -f database-compose.yml up -d --wait

# Setup database (migrate + seed)
npm run db:setup

# Start development server
npm run dev
```

Open http://localhost:3000 and login with the development credentials below.

### Development Credentials

Set these variables in `.env.local` before `npm run db:setup`: `.env.example` gives `SEED_USER_PASSWORD` a development value, and the platform admin has no default password.
The platform admin exists only when both `BOOTSTRAP_ADMIN_*` variables are set.

| Role | Email | Password |
|------|-------|----------|
| Platform Admin | `BOOTSTRAP_ADMIN_EMAIL` | `BOOTSTRAP_ADMIN_PASSWORD` |
| Tenant Admin | sarah.chen@acme.test | `SEED_USER_PASSWORD` |
| Editor | james.wilson@acme.test | `SEED_USER_PASSWORD` |
| Viewer | emily.park@acme.test | `SEED_USER_PASSWORD` |

### Docker

```bash
# Build production image
docker build -t libredb-platform .

# Run with Docker Compose: PostgreSQL, a one-shot migrate, and the app in cloud mode
docker compose up -d --wait
```

Open http://localhost:3000 and register an account; `APP_PORT=8080 docker compose up -d --wait` publishes another port.
With `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` set before the first `up`, the seed also creates a platform admin.
`docker-compose.yml` holds development passwords and secrets only, and `docker compose down -v` removes its data.

The image runs one command per container: `serve` (the default), `migrate`, `maintain`, `migrate-status` and `migrate-resolve`.
Its environment, the PostgreSQL and Keycloak it needs, the probes, the scheduler and the rotation and break-glass runbooks of a self-hosted install are in [`docs/deploy/platform-runtime.md`](docs/deploy/platform-runtime.md).

## Architecture

```
src/
├── app/                    # Next.js pages & API routes
│   ├── (auth)/             # Login, register, forgot-password
│   ├── (dashboard)/        # Protected: connections, team, audit, etc.
│   └── api/                # Auth.js, health, polling
├── features/               # 12 vertical slices (self-contained)
│   ├── auth/               # Login, register, logout, tenant switch
│   ├── tenants/            # Tenant CRUD, admin dashboard, plans, LOV
│   ├── users/              # User CRUD, invitation links, roles
│   ├── connections/        # DB connection CRUD, grants, credential sealing
│   ├── audit/              # Query audit log viewer
│   ├── billing/            # Plan info, usage, comparison
│   ├── support/            # Tickets, messages, attachments
│   ├── notifications/      # Bell icon, mark-read
│   ├── gamification/       # Achievements, streaks, XP
│   ├── license/            # License page: state, seats, seat holders
│   ├── studio-settings/    # Studio's runtime settings that admins set
│   └── studio-users/       # Studio users from Keycloak, session revocation
└── shared/                 # Shared kernel (never imports features)
    ├── components/         # shadcn/ui, gates, layout, feedback
    ├── lib/                # Auth, DB, logger, errors, storage, permissions
    ├── hooks/              # useAction, useCurrentUser
    ├── providers/          # React Query, Theme
    └── types/              # CurrentUser, Result
prisma/                     # Schema (36 models), migrations, seeds
```

**Dependency rule:** `app/ → features/ → shared/` (features never import each other)

## Database

36 models across 8 domains: Identity, Menu, Governance, Configuration, Support, Platform, Gamification, Jobs.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Turbopack) |
| `npm run build` | Production build (standalone) |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run E2E tests (Playwright) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |
| `npm run db:setup` | Migrate + seed |
| `ALLOW_DB_RESET=1 npm run db:reset` | Development only: drop schemas `bridge` and `platform`, migrate + seed |
| `npm run db:studio` | Open Prisma Studio |

## Getting help

Report bugs and ask questions in [GitHub Issues](https://github.com/libredb/libredb-platform/issues).
Report a security vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and never in a public issue.
For a license key, the free one included, or a renewal, write to [info@libredb.org](mailto:info@libredb.org).
To propose a change, open an issue, as [CONTRIBUTING.md](CONTRIBUTING.md) explains, because pull requests from outside the team are not accepted at this time.

## Related Projects

- **[libredb-studio](https://github.com/libredb/libredb-studio)**: Open-source database web editor, deployed as its own service

## License

LibreDB Platform, the installer included, is source-available under the [Elastic License 2.0](LICENSE), with SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ as the licensor.
You may use, copy, modify and self-host it.
You may not provide it to third parties as a hosted or managed service, move, change, disable or circumvent its license key functionality, remove or obscure any functionality that is protected by the license key, or alter, remove or obscure any licensing, copyright or other notices of the licensor.
This is a summary: the [LICENSE](LICENSE) file holds the full terms.

[LibreDB Studio](https://github.com/libredb/libredb-studio), the database web editor that Platform governs, stays open source in its own repository.

Every self-hosted install needs a license key, and Platform does not start in self-hosted mode without `PLATFORM_LICENSE`.
License keys come from SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ: write to [info@libredb.org](mailto:info@libredb.org) for a free license, which covers 1 admin seat and 3 user seats for 12 months, for a license with more seats, or for a renewal.
A key names the customer, the admin and user seats, an expiry and, optionally, the hosts it may run on, which must then include the host of `AUTH_URL`.
To install or renew a key, save the license file you receive at the path that the installer's `platform.licenseFile` names and run `libredb-installer apply -c <libredb.yaml>` as root, which passes it to Platform as `PLATFORM_LICENSE`, as the [Docker install guide](docs/deploy/install-docker.md) shows; without the installer, set `PLATFORM_LICENSE` to the token the file holds and restart `serve`.
Admins see a warning from 30 days before the key expires, and a grace period of 14 days follows the expiry, in which the key's seats still apply.
After the grace period no new users, connections or admins can be added, while existing access and the audit log keep working.
Platform also starts with a key that it cannot verify, which adds no user, connection or admin until a valid key is installed, while existing access keeps working.
[`docs/deploy/platform-runtime.md`](docs/deploy/platform-runtime.md#license) describes each license state, how seats are counted and which writes a license refuses.
