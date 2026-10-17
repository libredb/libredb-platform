// The Prisma configuration of the image's migrate, migrate-status and migrate-resolve subcommands
// (docs/deploy/platform-runtime.md).
// Unlike the root prisma.config.ts it reads no .env file: the migrate container receives MIGRATE_DATABASE_URL,
// the libredb_owner URL with schema=platform in Prisma syntax, and the Prisma CLI is its only user.
// The image keeps this file in /app/docker/migrator, next to the CLI it pins, and the schema in /app/prisma.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'prisma/config'

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export default defineConfig({
  schema: path.join(appDir, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(appDir, 'prisma', 'migrations'),
  },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL,
  },
})
