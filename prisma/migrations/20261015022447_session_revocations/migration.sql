-- Added by hand: a migration that touches schema bridge starts with this, so it cannot queue Studio's reads behind a long lock.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "platform"."session_revocations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "subject" TEXT NOT NULL,
    "revokedBefore" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_revocations_subject_revokedBefore_idx" ON "platform"."session_revocations"("subject", "revokedBefore" DESC);

-- AddForeignKey
ALTER TABLE "platform"."session_revocations" ADD CONSTRAINT "session_revocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "platform"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Added by hand: the column rules, on the camelCase columns.
-- A revocation names one Keycloak user by an opaque id of up to 512 characters, for one of the reasons Platform writes:
-- admin for "Revoke Studio sessions" and the break-glass statement, and the three transitions that directory sync detects.
ALTER TABLE "platform"."session_revocations" ADD CONSTRAINT "session_revocations_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 512);
ALTER TABLE "platform"."session_revocations" ADD CONSTRAINT "session_revocations_reason_check"
  CHECK ("reason" IN ('admin', 'user-disabled', 'user-deleted', 'role-removed'));

-- Added by hand: the change notification of kind revocations, sent after commit and never on rollback.
-- The break-glass statement of docs/deploy/platform-runtime.md, INSERT INTO platform.session_revocations (subject, reason) VALUES ('<id>', 'admin')
-- run as libredb_platform, sends it too, and the database default on id is what lets it name no id.
CREATE TRIGGER bridge_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform.session_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('revocations');

-- Added by hand: bridge.session_revocations_v1 of bridge contract v1, one row per subject with its latest revoked_before.
-- It is deny-only: Studio refuses a session of the subject issued at or before revoked_before, so a row ends sessions and never grants anything.
CREATE VIEW bridge.session_revocations_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT r.subject, max(r."revokedBefore") AS revoked_before
FROM platform.session_revocations r
GROUP BY r.subject;

-- The grants of bridge contract v1 for this view, and nothing to PUBLIC.
GRANT SELECT ON bridge.session_revocations_v1 TO libredb_studio, libredb_platform;
