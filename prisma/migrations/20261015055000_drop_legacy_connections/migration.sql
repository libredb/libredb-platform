-- Nothing reads the legacy connection table or its permission matrix since the connection, tenant, audit and seed code
-- moved to platform.database_connections and platform.connection_grants. Their rows are development data and are dropped,
-- not resealed.

-- DropForeignKey
ALTER TABLE "platform"."connection_permissions" DROP CONSTRAINT "connection_permissions_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "platform"."connection_permissions" DROP CONSTRAINT "connection_permissions_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "platform"."connection_permissions" DROP CONSTRAINT "connection_permissions_roleId_fkey";

-- DropForeignKey
ALTER TABLE "platform"."legacy_database_connections" DROP CONSTRAINT "legacy_database_connections_tenantId_fkey";

-- DropTable
DROP TABLE "platform"."connection_permissions";

-- DropTable
DROP TABLE "platform"."legacy_database_connections";

-- DropEnum
DROP TYPE "platform"."DatabaseType";

-- Without the permission matrix, connection.view lists and opens every connection of the tenant, so the system roles
-- TENANT_EDITOR and TENANT_VIEWER lose it and the Connections menu, which the seed only ever adds.
-- Access to a connection's data comes from grants in Studio.
DELETE FROM "platform"."role_permissions" rp
 USING "platform"."roles" r, "platform"."permissions" p
 WHERE rp."roleId" = r.id
   AND rp."permissionId" = p.id
   AND r."isSystem"
   AND r."tenantId" IS NULL
   AND r.code IN ('TENANT_EDITOR', 'TENANT_VIEWER')
   AND p.code = 'connection.view';

DELETE FROM "platform"."menu_roles" mr
 USING "platform"."roles" r, "platform"."menus" m
 WHERE mr."roleId" = r.id
   AND mr."menuId" = m.id
   AND r."isSystem"
   AND r."tenantId" IS NULL
   AND r.code IN ('TENANT_EDITOR', 'TENANT_VIEWER')
   AND m.code = 'CONNECTIONS';
