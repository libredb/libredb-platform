-- Added by hand: a migration that touches schema bridge starts with this, so it cannot queue Studio's reads behind a long lock.
SET lock_timeout = '5s';

-- Added by hand: publishes bridge contract version 1 now that every v1 object exists, as checked against the manifest
-- of the Studio build in tests/fixtures/governance/STUDIO_TAG by tests/db/contract-conformance.db.test.ts.
-- Version 1 is current, has no sunset and notifies on libredb_bridge.
-- CREATE OR REPLACE VIEW keeps the view's columns and grants, and it replaces the view's options with the ones it names, so it names them again.
CREATE OR REPLACE VIEW bridge.contract WITH (security_barrier = true, security_invoker = false) AS
SELECT c.version, c.status, c.sunset_after, c.notify_channel
FROM (VALUES (1::smallint, 'current'::text, NULL::timestamptz, 'libredb_bridge'::text))
     AS c(version, status, sunset_after, notify_channel);
