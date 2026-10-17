-- Added by hand: a migration that touches schema bridge starts with this, so it cannot queue Studio's reads behind a long lock.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "platform"."seal_canary" (
    "kid" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seal_canary_pkey" PRIMARY KEY ("kid")
);


-- Added by hand: the column rules of the seal canary.
-- A kid is 16 lowercase hex digits, and an envelope starts with its format and kid.
ALTER TABLE "platform"."seal_canary" ADD CONSTRAINT "seal_canary_kid_check" CHECK ("kid" ~ '^[0-9a-f]{16}$');
ALTER TABLE "platform"."seal_canary" ADD CONSTRAINT "seal_canary_envelope_check" CHECK ("envelope" ~ '^lsb[1-9][0-9]*\.[0-9a-f]{16}\.');

-- Added by hand: the base objects of bridge contract v1.
-- libredb_owner owns schema bridge and every object in it, and the runtime roles get USAGE and the grants at the end of this file only.
CREATE SCHEMA IF NOT EXISTS bridge;
REVOKE ALL ON SCHEMA bridge FROM PUBLIC;
GRANT USAGE ON SCHEMA bridge TO libredb_platform, libredb_studio;

-- Statement-level triggers on the contract source tables send {"v":1,"kind":...} on libredb_bridge, which PostgreSQL delivers after commit and never on rollback.
CREATE FUNCTION bridge.notify_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify('libredb_bridge', json_build_object('v', 1, 'kind', TG_ARGV[0])::text);
  RETURN NULL;
END $$;

CREATE TRIGGER bridge_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform.seal_canary
  FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('canary');

-- bridge.contract has its final shape, which never changes, and returns no row until a later migration publishes version 1,
-- so no build advertises v1 before every v1 object exists.
CREATE VIEW bridge.contract WITH (security_barrier = true, security_invoker = false) AS
SELECT c.version, c.status, c.sunset_after, c.notify_channel
FROM (VALUES (1::smallint, 'current'::text, NULL::timestamptz, 'libredb_bridge'::text))
     AS c(version, status, sunset_after, notify_channel)
WHERE false;

-- The Prisma column "createdAt" is published as created_at.
CREATE VIEW bridge.seal_canary_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT k.kid, k.envelope, k."createdAt" AS created_at
FROM platform.seal_canary k;

-- Query events: Studio inserts through bridge.query_events_v1 and cannot read them back, and Platform reads the table.
CREATE TABLE bridge.query_event (
  event_id              uuid        PRIMARY KEY,
  started_at            timestamptz NOT NULL,
  finished_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  contract_version      smallint    NOT NULL,
  studio_instance       text        NOT NULL CHECK (char_length(studio_instance) BETWEEN 1 AND 128),
  subject               text        NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 512),
  username              text        NULL CHECK (char_length(username) <= 320),
  session_role          text        NOT NULL CHECK (session_role IN ('admin','user')),
  connection_id         text        NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 64),
  connection_name       text        NULL CHECK (char_length(connection_name) <= 128),
  engine                text        NULL CHECK (engine ~ '^[a-z][a-z0-9]{0,31}$'),
  access_level          text        NULL CHECK (access_level IN ('read','write')),
  source                text        NOT NULL CHECK (source ~ '^[a-z][a-z-]{0,31}$'),
  statement_type        text        NOT NULL CHECK (statement_type IN ('SELECT','INSERT','UPDATE','DELETE','DDL','OTHER')),
  explain               text        NULL CHECK (explain IN ('plan','analyze')),
  statement_capture     text        NOT NULL CHECK (statement_capture IN ('none','redacted','full')),
  statement             text        NULL CHECK (octet_length(statement) <= 65536),
  statement_truncated   boolean     NOT NULL DEFAULT false,
  statement_fingerprint text        NULL CHECK (statement_fingerprint ~ '^[0-9a-f]{64}$'),
  unit_index            integer     NULL CHECK (unit_index >= 0),
  row_count             bigint      NULL CHECK (row_count >= 0),
  duration_ms           integer     NOT NULL CHECK (duration_ms >= 0),
  status                text        NOT NULL CHECK (status IN ('success','error','cancelled','refused')),
  error_code            text        NULL CHECK (char_length(error_code) <= 64),
  error_message         text        NULL CHECK (char_length(error_message) <= 1000),
  correlation_id        text        NULL CHECK (char_length(correlation_id) <= 128),
  transaction_id        text        NULL CHECK (char_length(transaction_id) <= 128),
  transaction_outcome   text        NULL CHECK (transaction_outcome ~ '^[a-z][a-z-]{0,31}$'),
  client_ip             inet        NULL,
  CONSTRAINT query_event_time_order CHECK (finished_at >= started_at),
  CONSTRAINT query_event_not_future CHECK (started_at <= received_at + interval '5 minutes'),
  CONSTRAINT query_event_capture_none CHECK (statement_capture <> 'none'
                                             OR (statement IS NULL AND statement_fingerprint IS NULL)),
  CONSTRAINT query_event_error_text_full_only CHECK (statement_capture = 'full' OR error_message IS NULL),
  CONSTRAINT query_event_resolved CHECK (status = 'refused' OR (engine IS NOT NULL AND access_level IS NOT NULL))
);
CREATE INDEX query_event_started_at_idx ON bridge.query_event (started_at);
CREATE INDEX query_event_connection_idx ON bridge.query_event (connection_id, started_at);
CREATE INDEX query_event_subject_idx    ON bridge.query_event (subject, started_at);

CREATE VIEW bridge.query_events_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT event_id, started_at, finished_at, contract_version, studio_instance, subject, username, session_role,
       connection_id, connection_name, engine, access_level, source, statement_type, explain,
       statement_capture, statement, statement_truncated, statement_fingerprint, unit_index, row_count,
       duration_ms, status, error_code, error_message, correlation_id, transaction_id, transaction_outcome,
       client_ip
FROM bridge.query_event
WHERE contract_version = 1
WITH LOCAL CHECK OPTION;
ALTER VIEW bridge.query_events_v1 ALTER COLUMN contract_version SET DEFAULT 1;

-- Heartbeat: each Studio instance upserts its row through bridge.studio_instances_v1, and Platform reads and deletes rows.
CREATE TABLE bridge.studio_instance (
  instance_id          text PRIMARY KEY CHECK (instance_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  studio_version       text NOT NULL CHECK (char_length(studio_version) BETWEEN 1 AND 64),
  supported_contracts  smallint[] NOT NULL DEFAULT '{}' CHECK (cardinality(supported_contracts) <= 16),
  contract_version     smallint NOT NULL,
  keyring_kids         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keyring_kids) <= 16),
  listener_state       text NOT NULL CHECK (listener_state IN ('listening','reconnecting','polling','deaf')),
  last_notification_at timestamptz NULL,
  snapshot_loaded_at   timestamptz NULL,
  skipped              jsonb NOT NULL DEFAULT '[]'::jsonb
                       CHECK (jsonb_typeof(skipped) = 'array' AND jsonb_array_length(skipped) <= 500),
  sink                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sink) = 'object'),
  canary               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(canary) = 'object'),
  started_at           timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW bridge.studio_instances_v1 WITH (security_barrier = true, security_invoker = false) AS
SELECT instance_id, studio_version, supported_contracts, contract_version, keyring_kids, listener_state,
       last_notification_at, snapshot_loaded_at, skipped, sink, canary, started_at, last_seen_at
FROM bridge.studio_instance;

-- Retention: only libredb_platform may run it, and it never deletes an event younger than 7 days.
CREATE FUNCTION bridge.trim_query_events(p_retention_days integer, p_batch integer DEFAULT 10000)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  -- Floor: a compromised Platform process can purge nothing younger than 7 days.
  v_cutoff  timestamptz := now() - make_interval(days => greatest(coalesce(p_retention_days, 90), 7));
  v_batch   integer := least(greatest(coalesce(p_batch, 10000), 1), 100000);
  v_deleted bigint;
BEGIN
  DELETE FROM bridge.query_event
  WHERE event_id IN (SELECT e.event_id FROM bridge.query_event e
                     WHERE e.started_at < v_cutoff ORDER BY e.started_at LIMIT v_batch);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION bridge.trim_query_events(integer, integer) FROM PUBLIC;

-- The grants of bridge contract v1 for these objects, and nothing to PUBLIC.
GRANT SELECT ON bridge.contract, bridge.seal_canary_v1
  TO libredb_studio, libredb_platform;
GRANT INSERT ON bridge.query_events_v1 TO libredb_studio;
GRANT SELECT, INSERT, UPDATE ON bridge.studio_instances_v1 TO libredb_studio;
GRANT SELECT ON bridge.query_event TO libredb_platform;
GRANT SELECT, DELETE ON bridge.studio_instance TO libredb_platform;
GRANT EXECUTE ON FUNCTION bridge.trim_query_events(integer, integer) TO libredb_platform;
