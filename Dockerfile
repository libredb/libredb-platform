# ==============================================================================
# LibreDB Platform - Production Dockerfile
# Multi-stage build for minimal production image
#
# Build:  docker build -t libredb-platform .
# Run:    docker run -p 3000:3000 --env-file .env.local libredb-platform
#
# One image, one subcommand per container (docker/entrypoint.sh, docs/deploy/platform-runtime.md):
# serve (the default), migrate, maintain, migrate-status and
# migrate-resolve (--rolled-back | --applied) <migration>.
# ==============================================================================

# Every stage starts from one node:24-bookworm-slim image, named by the digest of its multi-platform index, which
# serves linux/amd64 and linux/arm64. The tag moves to each new Node.js 24 release, and the digest keeps a rebuild on
# the Node.js whose node:crypto verifies license signatures with Ed25519. The runner runs what the other stages
# installed and built, so the four digests change together (scripts/ci/docker-context.test.ts).

# Stage 1: Install dependencies
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci --ignore-scripts
RUN npx prisma generate

# Stage 2: The migrator's dependencies, pinned to the root's installed versions
# (docker/migrator/versions.test.ts). Install scripts stay enabled, so that
# @prisma/engines downloads the schema engine for debian-openssl-3.0.x, which
# `prisma migrate` needs; openssl is installed first so that Prisma detects it.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS migrator-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY docker/migrator/package.json docker/migrator/package-lock.json docker/migrator/prisma.config.mjs ./docker/migrator/
# Prisma resolves @prisma/client from the schema's directory, so the client is generated from a copy of the schema
# next to the migrator's node_modules.
COPY prisma/schema.prisma ./docker/migrator/schema.prisma

WORKDIR /app/docker/migrator
ENV CHECKPOINT_DISABLE=1
RUN npm ci --no-audit --no-fund
RUN node node_modules/prisma/build/index.js generate --config prisma.config.mjs --schema schema.prisma
# After generate, which writes the client, the tree keeps only what the migrator's commands load:
# docker/prune-node-modules.sh deletes the declarations, source maps, TypeScript sources, tests and markdown, the
# query compilers of every database provider but the schema's, and the files of the Prisma CLI's dependencies that no
# command of the image opens, which docker/migrator/prisma-cli-prune.txt lists. The list stays in this stage.
COPY docker/prune-node-modules.sh /usr/local/bin/prune-node-modules
COPY docker/migrator/prisma-cli-prune.txt ./
RUN sh /usr/local/bin/prune-node-modules --prisma-schema schema.prisma --prisma-cli prisma-cli-prune.txt node_modules

# Stage 3: Build the application
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG AUTH_SECRET_BUILD=build-secret-placeholder-min-32-chars
ENV AUTH_SECRET=$AUTH_SECRET_BUILD
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build
# The standalone server's traced dependencies lose the same files as the migrator's, and the sharp builds for the
# libc this base image does not use (docker/prune-node-modules.sh); the runner stage shares this base image.
RUN sh docker/prune-node-modules.sh --prisma-schema prisma/schema.prisma .next/standalone/node_modules
# The seed and maintain bundles, so the runner needs neither src nor tsx.
RUN npm run build:migrator
# Git keeps no empty directory, so public/ is absent while it holds no file, and the runner copies it.
RUN mkdir -p public

# Stage 4: Production runner
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The Prisma CLI sends no usage data, so migrate needs no network access but PostgreSQL.
ENV CHECKPOINT_DISABLE=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The schema and the migrations: migrate applies them, and /api/health/ready compares them with the database.
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=migrator-deps /app/docker/migrator/node_modules ./docker/migrator/node_modules
COPY --from=builder /app/docker/migrator/dist ./docker/migrator/dist
COPY docker/migrator/package.json docker/migrator/preflight.mjs docker/migrator/prisma.config.mjs ./docker/migrator/
COPY --chmod=0755 docker/entrypoint.sh ./docker/entrypoint.sh
# Platform's license, the Elastic License 2.0: the label names it, and /app/LICENSE holds its text.
COPY LICENSE ./LICENSE
LABEL org.opencontainers.image.licenses="Elastic-2.0"

# Create uploads directory for local storage
RUN mkdir -p uploads && chown nextjs:nodejs uploads

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# The liveness probe on the port the server listens on; it does no I/O.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health/live').then(r => { if (!r.ok) throw r.status }).catch(() => process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
