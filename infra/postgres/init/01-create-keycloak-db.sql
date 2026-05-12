-- Runs once on first Postgres volume init. Creates the keycloak DB
-- owned by the same superuser used for the aggregator DB.
CREATE DATABASE keycloak;
GRANT ALL PRIVILEGES ON DATABASE keycloak TO CURRENT_USER;
