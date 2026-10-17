-- Added by hand: a migration that touches schema bridge starts with this, so it cannot queue Studio's reads behind a long lock.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "platform"."GrantLevel" AS ENUM ('read', 'write');

-- CreateTable
CREATE TABLE "platform"."connection_grants" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL DEFAULT 'user',
    "subject" TEXT NOT NULL,
    "subjectUsername" TEXT NOT NULL,
    "subjectEmail" TEXT,
    "level" "platform"."GrantLevel" NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_grants_subject_idx" ON "platform"."connection_grants"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "connection_grants_connectionId_subjectKind_subject_key" ON "platform"."connection_grants"("connectionId", "subjectKind", "subject");

-- AddForeignKey
ALTER TABLE "platform"."connection_grants" ADD CONSTRAINT "connection_grants_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform"."database_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."connection_grants" ADD CONSTRAINT "connection_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Added by hand: the column rules, on the camelCase columns.
-- A grant names one Keycloak user, by an opaque id of up to 512 characters,
-- and an expiry lies after the grant time.
ALTER TABLE "platform"."connection_grants" ADD CONSTRAINT "connection_grants_subjectKind_check" CHECK ("subjectKind" IN ('user'));
ALTER TABLE "platform"."connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 512);
ALTER TABLE "platform"."connection_grants" ADD CONSTRAINT "connection_grants_expiry_after_grant"
  CHECK ("expiresAt" IS NULL OR "expiresAt" > "grantedAt");

-- Added by hand: the change notification of kind grants, sent after commit and never on rollback.
-- The break-glass statement of docs/deploy/platform-runtime.md, DELETE FROM platform.connection_grants WHERE subject = '<id>' run as libredb_platform, sends it too.
CREATE TRIGGER bridge_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform.connection_grants
  FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('grants');

-- Added by hand: bridge.grants_v1 of bridge contract v1, one effective row per subject and connection.
-- It aggregates the unexpired grants of user subjects on the connections that bridge.connections_v1 publishes, which are active and not deleted.
-- level is write only when some grant is write and the connection has a write secret; otherwise it is read, and downgraded is true when a write was requested.
-- expires_at is when the current level stops, or NULL when it does not. Expiry fires no trigger, so Studio re-checks it against its own clock.
-- The view publishes level as text, so the enum GrantLevel never reaches the contract.
CREATE VIEW bridge.grants_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT a.subject,
       a.connection_id,
       CASE WHEN a.has_write AND a.write_secret_present THEN 'write' ELSE 'read' END AS level,
       CASE WHEN a.has_write AND a.write_secret_present
            THEN CASE WHEN a.write_open_ended THEN NULL ELSE a.write_max_expiry END
            ELSE CASE WHEN a.any_open_ended THEN NULL ELSE a.any_max_expiry END
       END AS expires_at,
       (a.has_write AND NOT a.write_secret_present) AS downgraded,
       a.first_granted_at AS granted_at
FROM (
  SELECT g.subject, g."connectionId" AS connection_id,
         bool_or(g.level = 'write')                           AS has_write,
         bool_or(g.level = 'write' AND g."expiresAt" IS NULL) AS write_open_ended,
         max(g."expiresAt") FILTER (WHERE g.level = 'write')  AS write_max_expiry,
         bool_or(g."expiresAt" IS NULL)                       AS any_open_ended,
         max(g."expiresAt")                                   AS any_max_expiry,
         min(g."grantedAt")                                   AS first_granted_at,
         bool_or(c."writeSecret" IS NOT NULL)                 AS write_secret_present
  FROM platform.connection_grants g
  JOIN platform.database_connections c ON c.id = g."connectionId"
  WHERE c.active
    AND c."deletedAt" IS NULL
    AND g."subjectKind" = 'user'
    AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
  GROUP BY g.subject, g."connectionId"
) a;

-- The grants of bridge contract v1 for this view, and nothing to PUBLIC.
GRANT SELECT ON bridge.grants_v1 TO libredb_studio, libredb_platform;
