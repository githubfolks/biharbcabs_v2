-- ==============================================================================
-- Migration 36: Route Distance Cache (LocationIQ driving distances)
-- ==============================================================================
-- Caches road distances & drive durations returned by LocationIQ so repeated
-- source-to-destination lookups do not consume API quota.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_route_distance_cache (
    cache_key VARCHAR(160) PRIMARY KEY,
    origin_label TEXT,
    destination_label TEXT,
    from_lat NUMERIC(10, 6),
    from_lon NUMERIC(10, 6),
    to_lat NUMERIC(10, 6),
    to_lon NUMERIC(10, 6),
    distance_km NUMERIC(10, 2) NOT NULL CHECK (distance_km > 0),
    duration_minutes INTEGER NOT NULL DEFAULT 1,
    duration_text VARCHAR(60) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_route_distance_cache_expiry ON crm_route_distance_cache (expires_at);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('36', 'Route distance cache for LocationIQ driving distances')
ON CONFLICT (version) DO NOTHING;
