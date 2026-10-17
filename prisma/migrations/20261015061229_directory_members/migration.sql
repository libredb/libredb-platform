-- CreateTable
-- Added by hand: roles is NOT NULL, which Prisma never writes for a list column; directory sync stores every member with
-- the LibreDB roles, admin and user, that it holds.
CREATE TABLE "platform"."directory_members" (
    "subject" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "roles" TEXT[] NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "directory_members_pkey" PRIMARY KEY ("subject")
);
