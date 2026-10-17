-- Added by hand: a migration that touches schema bridge starts with this, so it cannot queue Studio's reads behind a long lock.
SET lock_timeout = '5s';

-- Replaced by hand: Prisma generates a rebuild of the existing table in place, which drops its columns with their rows.
-- The existing table moves aside instead, and its primary key, foreign key and index take the names Prisma derives for
-- LegacyDatabaseConnection, so no row is lost. The legacy rows are development data that a later migration drops.
-- The foreign keys of connection_permissions and query_audit_logs keep their names and follow the renamed table.
ALTER TABLE "platform"."database_connections" RENAME TO "legacy_database_connections";
ALTER TABLE "platform"."legacy_database_connections" RENAME CONSTRAINT "database_connections_pkey" TO "legacy_database_connections_pkey";
ALTER TABLE "platform"."legacy_database_connections" RENAME CONSTRAINT "database_connections_tenantId_fkey" TO "legacy_database_connections_tenantId_fkey";
ALTER INDEX "platform"."database_connections_tenantId_idx" RENAME TO "legacy_database_connections_tenantId_idx";

-- CreateTable
CREATE TABLE "platform"."database_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "environment" TEXT,
    "groupName" TEXT,
    "color" TEXT,
    "definition" JSONB NOT NULL,
    "readSecret" TEXT NOT NULL,
    "writeSecret" TEXT,
    "mcpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_connections_tenantId_idx" ON "platform"."database_connections"("tenantId");

-- AddForeignKey
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "platform"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "platform"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Added by hand: the column rules, on the camelCase columns.
-- Platform generates the id with crypto.randomUUID(), and both envelopes start with their format and the kid of the seal key.
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_id_format" CHECK ("id" ~ '^[a-z0-9-]{1,64}$');
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_name_check" CHECK (char_length("name") BETWEEN 1 AND 128);
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_engine_check" CHECK ("engine" ~ '^[a-z][a-z0-9]{0,31}$');
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_environment_check"
  CHECK ("environment" IN ('production', 'staging', 'development', 'local', 'other'));
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_groupName_check" CHECK (char_length("groupName") BETWEEN 1 AND 64);
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_color_check" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_definition_check" CHECK (jsonb_typeof("definition") = 'object');
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_readSecret_format"
  CHECK ("readSecret" ~ '^lsb[1-9][0-9]*\.[0-9a-f]{16}\.');
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_writeSecret_format"
  CHECK ("writeSecret" ~ '^lsb[1-9][0-9]*\.[0-9a-f]{16}\.');
-- A credential never sits in the definition: it lives only in the sealed envelopes, and Studio refuses it again.
ALTER TABLE "platform"."database_connections" ADD CONSTRAINT "database_connections_definition_no_secrets" CHECK (
  NOT ("definition" ?| ARRAY['user', 'password', 'connectionString', 'privateKey', 'privateKeyPassphrase',
                             'apiKeyId', 'apiKeySecret', 'agentUser', 'agentPassword', 'sshTunnel'])
  AND NOT (coalesce("definition" -> 'ssl', '{}'::jsonb) ?| ARRAY['clientKey'])
);

-- Added by hand: the rebind rule. The AAD of a sealed secret binds the id, the engine and the exact definition,
-- so changing any of them requires a newly sealed read secret and either a newly sealed write secret or its removal.
-- libredb_owner owns the table, the function and the trigger, so the runtime role can neither drop nor disable it.
-- Every update is stamped with the database clock, which bridge.connections_v1 publishes as updated_at.
CREATE FUNCTION platform.database_connections_rebind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.engine IS DISTINCT FROM OLD.engine
     OR NEW.definition IS DISTINCT FROM OLD.definition THEN
    IF NEW."readSecret" = OLD."readSecret" THEN
      RAISE EXCEPTION 'connection %: changing id, engine or definition requires a newly sealed read secret', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF OLD."writeSecret" IS NOT NULL AND NEW."writeSecret" IS NOT DISTINCT FROM OLD."writeSecret" THEN
      RAISE EXCEPTION 'connection %: re-seal the write secret or set it to NULL explicitly', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER database_connections_rebind BEFORE UPDATE ON platform.database_connections
  FOR EACH ROW EXECUTE FUNCTION platform.database_connections_rebind();

-- Added by hand: the change notification of kind connections, sent after commit and never on rollback.
CREATE TRIGGER bridge_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform.database_connections
  FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('connections');

-- Added by hand: bridge.connections_v1 of bridge contract v1, which publishes the connections that are active and not deleted
-- and aliases the camelCase columns to the names of the contract.
CREATE VIEW bridge.connections_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT c.id AS connection_id, c.name, c.engine, c.environment, c."groupName" AS group_name, c.color,
       c.definition, c."readSecret" AS read_secret, c."writeSecret" AS write_secret, c."mcpEnabled" AS mcp_enabled,
       c."updatedAt" AS updated_at
FROM platform.database_connections c
WHERE c.active AND c."deletedAt" IS NULL;

-- The grants of bridge contract v1 for this view, and nothing to PUBLIC.
GRANT SELECT ON bridge.connections_v1 TO libredb_studio, libredb_platform;
