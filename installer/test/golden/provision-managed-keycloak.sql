-- Rendered by libredb-installer: Platform's PostgreSQL bootstrap, run as the admin role.
-- Every password is a SCRAM-SHA-256 verifier in a psql variable, so no cleartext password reaches the server.
\set ON_ERROR_STOP on
\set owner_pw 'SCRAM-SHA-256$4096:AQEBAQEBAQEBAQEBAQEBAQ==$p2vF3ZsFmPwzsbgOcN2g+7k/fWisfd3tyzl2bSfZJoo=:LfEM/w5xfSqrgZdpr0bPIKrhhiHxkGJX0XhhcZ7FJRQ='
\set platform_pw 'SCRAM-SHA-256$4096:AgICAgICAgICAgICAgICAg==$Zxg/d+KWrJa4NRN0DILApAYjO2DSsYwGm/cTRpFKl4A=:SE2ix6Xf7bbsVndZZGQR60zMZIimAQFDpfLE+Gh6XI4='
\set studio_pw 'SCRAM-SHA-256$4096:AwMDAwMDAwMDAwMDAwMDAw==$i/Mhacg1zKBFR5tfUwGztMs4/WWl1dc7EOVh2agCkqM=:BkISpfQJjJrtWVDEtUjkdxmxcPNddGQEudm6GkLGfqU='
\set keycloak_pw 'SCRAM-SHA-256$4096:BAQEBAQEBAQEBAQEBAQEBA==$jCV0et8GLv302NPyzIo9VJeSrtizo477YK+uLXJwz/M=:tbmuo/c3phhscuC2ukO+WWS/g8TG1WHFMaf92mF1ENw='
\set backup_pw 'SCRAM-SHA-256$4096:BQUFBQUFBQUFBQUFBQUFBQ==$3UUDOgNo1CZzSjl0H6FByvDEBdV2F9sDJYtjj7iQH5E=:+mEaVXekQzd6JdaTDuGmC7vMIdXpvw0z7l1C9g1NtMI='
SELECT current_setting('server_version_num')::int >= 160000 AS pg16, NOT r.rolsuper AS grant_self,
       pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER WITH ADMIN OPTION') AS backup_role
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user \gset

-- Roles: created when missing, their attributes restored only when they drifted.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5', 'libredb_owner', :'owner_pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'libredb_owner') \gexec
SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END || CASE WHEN rolconnlimit <> 5 THEN ' CONNECTION LIMIT 5' ELSE '' END FROM pg_catalog.pg_roles
  WHERE rolname = 'libredb_owner' AND NOT (rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND rolconnlimit = 5) \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 25', 'libredb_platform', :'platform_pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'libredb_platform') \gexec
SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END || CASE WHEN rolconnlimit <> 25 THEN ' CONNECTION LIMIT 25' ELSE '' END FROM pg_catalog.pg_roles
  WHERE rolname = 'libredb_platform' AND NOT (rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND rolconnlimit = 25) \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30', 'libredb_studio', :'studio_pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'libredb_studio') \gexec
SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END || CASE WHEN rolconnlimit <> 30 THEN ' CONNECTION LIMIT 30' ELSE '' END FROM pg_catalog.pg_roles
  WHERE rolname = 'libredb_studio' AND NOT (rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND rolconnlimit = 30) \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 25', 'libredb_keycloak', :'keycloak_pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'libredb_keycloak') \gexec
SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END || CASE WHEN rolconnlimit <> 25 THEN ' CONNECTION LIMIT 25' ELSE '' END FROM pg_catalog.pg_roles
  WHERE rolname = 'libredb_keycloak' AND NOT (rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND rolconnlimit = 25) \gexec
\if :backup_role
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', 'libredb_backup', :'backup_pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'libredb_backup') \gexec
SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END FROM pg_catalog.pg_roles
  WHERE rolname = 'libredb_backup' AND NOT (rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) \gexec
GRANT pg_read_all_data TO "libredb_backup";
\endif
ALTER ROLE "libredb_platform" PASSWORD :'platform_pw';

-- A non-superuser admin grants itself the roles it switches to with SET ROLE.
\if :grant_self
\if :pg16
GRANT "libredb_owner", "libredb_studio", "libredb_keycloak" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
\else
GRANT "libredb_owner", "libredb_studio", "libredb_keycloak" TO CURRENT_USER;
\endif
\endif

-- Databases
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', 'libredb', 'libredb_owner')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = 'libredb') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', 'keycloak', 'libredb_keycloak')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = 'keycloak') \gexec
SET ROLE "libredb_keycloak";
REVOKE ALL ON DATABASE "keycloak" FROM PUBLIC;
\if :backup_role
GRANT CONNECT ON DATABASE "keycloak" TO "libredb_backup";
\endif
RESET ROLE;

\connect 'libredb'
SET ROLE "libredb_owner";
REVOKE ALL ON DATABASE "libredb" FROM PUBLIC;
GRANT CONNECT ON DATABASE "libredb" TO "libredb_owner", "libredb_platform", "libredb_studio";
\if :backup_role
GRANT CONNECT ON DATABASE "libredb" TO "libredb_backup";
\endif
-- Beyond the bootstrap, which starts from nothing: revoke what a drifted server granted the app roles.
REVOKE CREATE ON DATABASE "libredb" FROM "libredb_platform";
REVOKE ALL ON DATABASE "libredb" FROM "libredb_keycloak";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'studio') AS create_studio_schema \gset
\if :create_studio_schema
GRANT CREATE ON DATABASE "libredb" TO "libredb_studio";
SET ROLE "libredb_studio";
CREATE SCHEMA "studio" AUTHORIZATION "libredb_studio";
SET ROLE "libredb_owner";
\endif
REVOKE CREATE ON DATABASE "libredb" FROM "libredb_studio";
SET ROLE "libredb_studio";
REVOKE ALL ON SCHEMA "studio" FROM "libredb_platform";
RESET ROLE;

-- Role settings, each set only when it is missing or differs.
SELECT format('ALTER ROLE %I IN DATABASE %I SET %I = %L', wanted.role, 'libredb', wanted.name, wanted.value)
  FROM (VALUES ('libredb_owner', 'search_path', 'platform'),
              ('libredb_platform', 'search_path', 'platform'),
              ('libredb_studio', 'search_path', 'studio'),
              ('libredb_studio', 'statement_timeout', '30s'),
              ('libredb_studio', 'idle_in_transaction_session_timeout', '60s'),
              ('libredb_platform', 'idle_in_transaction_session_timeout', '60s')) AS wanted(role, name, value)
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s
    WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = wanted.role)
      AND s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'libredb')
      AND wanted.name || '=' || wanted.value = ANY (s.setconfig)) \gexec
-- Never set idle_session_timeout for libredb_studio: it would end Studio's LISTEN connection.
SELECT format('ALTER ROLE %I IN DATABASE %I RESET idle_session_timeout', 'libredb_studio', 'libredb')
  WHERE EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS entry WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'libredb_studio') AND s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'libredb') AND split_part(entry, '=', 1) = 'idle_session_timeout') \gexec
SELECT format('ALTER ROLE %I RESET idle_session_timeout', 'libredb_studio')
  WHERE EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS entry WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'libredb_studio') AND s.setdatabase = 0 AND split_part(entry, '=', 1) = 'idle_session_timeout') \gexec
