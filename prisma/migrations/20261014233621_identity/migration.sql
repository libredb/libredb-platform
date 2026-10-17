-- CreateTable
CREATE TABLE "platform"."password_credentials" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("userId")
);

-- Added by hand: a credential email is the lower-cased sign-in name, so the unique index below also refuses an email that differs only in case.
ALTER TABLE "platform"."password_credentials" ADD CONSTRAINT "password_credentials_email_lowercase_check" CHECK ("email" = lower("email"));

-- CreateIndex
CREATE UNIQUE INDEX "password_credentials_email_key" ON "platform"."password_credentials"("email");

-- AddForeignKey
ALTER TABLE "platform"."password_credentials" ADD CONSTRAINT "password_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Added by hand: move the existing password hashes before users."passwordHash" is dropped; on an empty database this copies nothing.
-- Two users whose emails differ only in case collide on password_credentials_email_key, which stops the migration.
INSERT INTO "platform"."password_credentials" ("userId", "email", "passwordHash", "updatedAt")
SELECT "id", lower("email"), "passwordHash", "updatedAt"
  FROM "platform"."users"
 WHERE "passwordHash" IS NOT NULL;

-- DropIndex
DROP INDEX "platform"."users_email_key";

-- AlterTable
ALTER TABLE "platform"."users" DROP COLUMN "passwordHash",
ADD COLUMN     "keycloakId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_keycloakId_key" ON "platform"."users"("keycloakId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "platform"."users"("email");
