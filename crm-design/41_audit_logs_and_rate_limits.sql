-- ==============================================================================
-- Migration 41: Unified Immutable Audit Log & Public API Rate Limit Policy
-- ==============================================================================

CREATE TABLE IF NOT EXISTS crm_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    actor_email VARCHAR(150),
    actor_name VARCHAR(150),
    actor_role VARCHAR(50),
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id VARCHAR(80),
    summary TEXT NOT NULL,
    before_data JSONB,
    after_data JSONB,
    ip_address VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_audit_logs_created_at ON crm_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_logs_action ON crm_audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_logs_entity ON crm_audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_audit_logs_actor ON crm_audit_logs(actor_id, created_at DESC);

-- Seed configurable public API rate-limit policy (DB-driven, editable via Settings).
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'public_rate_limits',
    '{"bookings_per_ip_10m": 10, "bookings_per_phone_10m": 5, "plans_per_ip_10m": 60, "autocomplete_per_ip_10m": 120}'::jsonb,
    'Per-10-minute sliding-window rate limits for public WordPress booking, plans, and autocomplete endpoints.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- Grant append-only privileges to crm_app role if present (audit logs are never updated or deleted by the app).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT ON crm_audit_logs TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_audit_logs_id_seq TO crm_app;
    END IF;
END $$;
