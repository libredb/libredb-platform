import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// A variable already set in the environment wins over .env.local, which wins over .env,
// so a caller that passes MIGRATE_DATABASE_URL (the migrate job, tests/db/global-setup.ts) migrates that database.
dotenv.config({ path: path.join(__dirname, ".env.local") });
dotenv.config({ path: path.join(__dirname, ".env") });

// The Prisma CLI is the only user of these URLs, and it connects as libredb_owner, the role that owns schema platform.
// MIGRATE_DATABASE_URL is the libredb_owner URL with schema=platform in Prisma syntax.
// SHADOW_DATABASE_URL is a database libredb_owner owns, for `prisma migrate dev` and `prisma migrate diff --from-migrations`.
// The runtime connects as libredb_platform through DATABASE_URL and never receives either URL.
export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    seed: "npx tsx prisma/seed.ts",
  },
});
