-- Postgres entrypoint scripts under /docker-entrypoint-initdb.d/ run only on
-- first init (empty PGDATA). The compose POSTGRES_DB env var creates the
-- `aggregator` database; Keycloak needs its own `keycloak` database, so we
-- create it here. Owner matches POSTGRES_USER so the same connection string
-- works without extra grants.
CREATE DATABASE keycloak OWNER aggregator;
