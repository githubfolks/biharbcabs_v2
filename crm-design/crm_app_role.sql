-- Database role the CRM application connects as (inside Docker, over TCP, with a password).
--
-- Run once per environment as the owner of the CRM tables (the role that applies migrations),
-- passing the password from the root .env (CRM_DB_PASSWORD), never typing it into this file:
--
--   psql -v ON_ERROR_STOP=1 -d biharcabs_crm -v pw="$CRM_DB_PASSWORD" -f crm-design/crm_app_role.sql
--
-- Safe to run again: it creates the role if missing, otherwise resets its password, and re-applies grants.
-- The role can read and write data only. It cannot create, alter or drop tables: schema changes stay
-- with migrations, applied by the owner.

SELECT set_config('crm.app_pw', :'pw', false);

DO $$
DECLARE
  pw text := current_setting('crm.app_pw');
BEGIN
  IF pw IS NULL OR length(pw) < 24 THEN
    RAISE EXCEPTION 'CRM_DB_PASSWORD must be at least 24 characters';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'biharcabs_crm') THEN
    EXECUTE format('ALTER ROLE biharcabs_crm WITH LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('CREATE ROLE biharcabs_crm LOGIN PASSWORD %L', pw);
  END IF;
END $$;

SELECT set_config('crm.app_pw', '', false);

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO biharcabs_crm', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO biharcabs_crm;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO biharcabs_crm;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO biharcabs_crm;

-- Tables and sequences that later migrations create (as the current role) get the same access.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO biharcabs_crm;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO biharcabs_crm;
