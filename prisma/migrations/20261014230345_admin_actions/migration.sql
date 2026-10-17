-- CreateTable
CREATE TABLE "platform"."admin_actions" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "platform"."admin_actions" ADD CONSTRAINT "admin_actions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Added by hand: an action is a lowercase dotted name such as grant.create or connection.update.
ALTER TABLE "platform"."admin_actions" ADD CONSTRAINT "admin_actions_action_check" CHECK ("action" ~ '^[a-z]+(\.[a-z-]+)+$');

-- Added by hand: the admin action log is append-only for the runtime role.
-- The default privileges of the baseline grant libredb_platform DML on every new table, so this keeps INSERT and SELECT only.
REVOKE UPDATE, DELETE, TRUNCATE ON "platform"."admin_actions" FROM libredb_platform;
