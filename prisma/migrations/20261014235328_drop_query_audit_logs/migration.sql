-- DropForeignKey
ALTER TABLE "platform"."query_audit_logs" DROP CONSTRAINT "query_audit_logs_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "platform"."query_audit_logs" DROP CONSTRAINT "query_audit_logs_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "platform"."query_audit_logs" DROP CONSTRAINT "query_audit_logs_userId_fkey";

-- DropTable
DROP TABLE "platform"."query_audit_logs";

