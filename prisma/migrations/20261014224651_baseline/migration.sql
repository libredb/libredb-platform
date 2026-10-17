-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- Added by hand: the privileges of the database roles.
-- libredb_owner runs every migration and owns schema platform and every object in it.
-- libredb_platform, the runtime role, gets DML on every table and sequence libredb_owner creates here, and no DDL.
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO libredb_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE libredb_owner IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO libredb_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE libredb_owner IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO libredb_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE libredb_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Added by hand: readiness compares the applied migrations with the image's, so the runtime role reads the history.
-- Prisma creates platform._prisma_migrations before it applies a migration, so the default privileges above do not cover it.
-- The shadow database of `prisma migrate dev` and `prisma migrate diff --from-migrations` has no history table and needs no grant.
DO $$
BEGIN
  IF to_regclass('platform._prisma_migrations') IS NOT NULL THEN
    GRANT SELECT ON platform._prisma_migrations TO libredb_platform;
  ELSIF EXISTS (SELECT FROM pg_catalog.pg_class WHERE relname = '_prisma_migrations' AND relkind = 'r') THEN
    RAISE EXCEPTION 'the Prisma migration history must be platform._prisma_migrations: MIGRATE_DATABASE_URL must include schema=platform';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "platform"."DatabaseType" AS ENUM ('POSTGRESQL', 'MYSQL', 'SQLITE', 'ORACLE', 'MSSQL', 'MONGODB', 'REDIS');

-- CreateTable
CREATE TABLE "platform"."tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "settings" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "planConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "avatarUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."tenant_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."user_roles" (
    "membershipId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "platform"."role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "platform"."invitations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."menus" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."menu_roles" (
    "menuId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "menu_roles_pkey" PRIMARY KEY ("menuId","roleId")
);

-- CreateTable
CREATE TABLE "platform"."database_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "platform"."DatabaseType" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "sslEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sshTunnelConfig" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."connection_permissions" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "membershipId" TEXT,
    "roleId" TEXT,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."query_audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "rowsAffected" INTEGER,
    "executionTimeMs" INTEGER,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."plan_configs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "maxUsers" INTEGER NOT NULL DEFAULT 1,
    "maxConnections" INTEGER NOT NULL DEFAULT 3,
    "queryHistoryDays" INTEGER NOT NULL DEFAULT 7,
    "featureSharedQueries" BOOLEAN NOT NULL DEFAULT false,
    "featureAdvancedRbac" BOOLEAN NOT NULL DEFAULT false,
    "featureAuditLog" BOOLEAN NOT NULL DEFAULT false,
    "featurePerfTracking" BOOLEAN NOT NULL DEFAULT false,
    "featureDataMasking" BOOLEAN NOT NULL DEFAULT false,
    "featureSamlSso" BOOLEAN NOT NULL DEFAULT false,
    "featureScimProvisioning" BOOLEAN NOT NULL DEFAULT false,
    "featureSelfHosted" BOOLEAN NOT NULL DEFAULT false,
    "featureApiAccess" BOOLEAN NOT NULL DEFAULT false,
    "pricePerUserMonthly" DECIMAL(10,2),
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."reference_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."reference_values" (
    "id" TEXT NOT NULL,
    "referenceTypeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "translations" JSONB,
    "colorCode" TEXT,
    "icon" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ticketNumber" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "descriptionRich" TEXT,
    "descriptionPlain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "createdByUserId" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "satisfactionRating" INTEGER,
    "satisfactionComment" TEXT,
    "satisfactionAt" TIMESTAMP(3),
    -- Added by hand, because Prisma cannot express a generated column.
    -- The 'simple' dictionary does no stemming, so Turkish and English text mix without wrong stems.
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("subject", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("descriptionPlain", '')), 'B')
    ) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "content" TEXT,
    "bodyRich" TEXT,
    "bodyPlain" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "editedAt" TIMESTAMP(3),
    "mentionedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    -- Added by hand, because Prisma cannot express a generated column.
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("bodyPlain", ''))) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_activities" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_tags" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "colorCode" TEXT,
    "description" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_ticket_tags" (
    "ticketId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_tags_pkey" PRIMARY KEY ("ticketId","tagId")
);

-- CreateTable
CREATE TABLE "platform"."notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "savedQueries" JSONB,
    "editorSettings" JSONB,
    "recentConnections" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."shared_queries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sql" TEXT NOT NULL,
    "connectionId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."achievements" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."user_achievements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "unlockedAt" TIMESTAMP(3),
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."user_streaks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "totalActiveDays" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_streaks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "platform"."tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "platform"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenantId_userId_key" ON "platform"."tenant_members"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_code_key" ON "platform"."roles"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "platform"."permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "platform"."invitations"("token");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenantId_email_key" ON "platform"."invitations"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "menus_code_key" ON "platform"."menus"("code");

-- CreateIndex
CREATE INDEX "database_connections_tenantId_idx" ON "platform"."database_connections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "connection_permissions_connectionId_membershipId_key" ON "platform"."connection_permissions"("connectionId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "connection_permissions_connectionId_roleId_key" ON "platform"."connection_permissions"("connectionId", "roleId");

-- CreateIndex
CREATE INDEX "query_audit_logs_tenantId_createdAt_idx" ON "platform"."query_audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "query_audit_logs_userId_createdAt_idx" ON "platform"."query_audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "query_audit_logs_connectionId_createdAt_idx" ON "platform"."query_audit_logs"("connectionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "plan_configs_code_key" ON "platform"."plan_configs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "reference_types_code_key" ON "platform"."reference_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "reference_types_name_key" ON "platform"."reference_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "reference_values_code_key" ON "platform"."reference_values"("code");

-- CreateIndex
CREATE INDEX "support_tickets_tenantId_status_lastActivityAt_idx" ON "platform"."support_tickets"("tenantId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "support_tickets_assignedToUserId_status_idx" ON "platform"."support_tickets"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "support_tickets_searchVector_idx" ON "platform"."support_tickets" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tenantId_ticketNumber_key" ON "platform"."support_tickets"("tenantId", "ticketNumber");

-- CreateIndex
CREATE INDEX "support_messages_ticketId_createdAt_idx" ON "platform"."support_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "support_messages_searchVector_idx" ON "platform"."support_messages" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "support_attachments_messageId_idx" ON "platform"."support_attachments"("messageId");

-- CreateIndex
CREATE INDEX "support_activities_ticketId_createdAt_idx" ON "platform"."support_activities"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_tags_tenantId_name_key" ON "platform"."support_tags"("tenantId", "name");

-- CreateIndex
CREATE INDEX "support_ticket_tags_tagId_idx" ON "platform"."support_ticket_tags"("tagId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_createdAt_idx" ON "platform"."notifications"("userId", "read", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "platform"."subscriptions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "platform"."user_preferences"("userId");

-- CreateIndex
CREATE INDEX "shared_queries_tenantId_idx" ON "platform"."shared_queries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "achievements_code_key" ON "platform"."achievements"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_userId_achievementId_key" ON "platform"."user_achievements"("userId", "achievementId");

-- CreateIndex
CREATE UNIQUE INDEX "user_streaks_userId_key" ON "platform"."user_streaks"("userId");

-- AddForeignKey
ALTER TABLE "platform"."tenants" ADD CONSTRAINT "tenants_planConfigId_fkey" FOREIGN KEY ("planConfigId") REFERENCES "platform"."plan_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."tenant_members" ADD CONSTRAINT "tenant_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."tenant_members" ADD CONSTRAINT "tenant_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."user_roles" ADD CONSTRAINT "user_roles_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "platform"."tenant_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "platform"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."menus" ADD CONSTRAINT "menus_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "platform"."menus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."menu_roles" ADD CONSTRAINT "menu_roles_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "platform"."menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."menu_roles" ADD CONSTRAINT "menu_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."connection_permissions" ADD CONSTRAINT "connection_permissions_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform"."database_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."connection_permissions" ADD CONSTRAINT "connection_permissions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "platform"."tenant_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."connection_permissions" ADD CONSTRAINT "connection_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."query_audit_logs" ADD CONSTRAINT "query_audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."query_audit_logs" ADD CONSTRAINT "query_audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."query_audit_logs" ADD CONSTRAINT "query_audit_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform"."database_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."reference_values" ADD CONSTRAINT "reference_values_referenceTypeId_fkey" FOREIGN KEY ("referenceTypeId") REFERENCES "platform"."reference_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_tickets" ADD CONSTRAINT "support_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "platform"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_attachments" ADD CONSTRAINT "support_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "platform"."support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_activities" ADD CONSTRAINT "support_activities_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "platform"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_tags" ADD CONSTRAINT "support_tags_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "platform"."support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "platform"."support_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."shared_queries" ADD CONSTRAINT "shared_queries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."user_achievements" ADD CONSTRAINT "user_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "platform"."achievements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
