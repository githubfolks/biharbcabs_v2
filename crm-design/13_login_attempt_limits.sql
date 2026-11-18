-- ==============================================================================
-- Migration 13: Limit failed admin sign-in attempts
-- ==============================================================================
-- Every sign-in attempt is recorded. An email with too many failed attempts inside the window is
-- refused (429) until the window passes; optionally, so is a client IP (only when the deployment
-- names a trusted client-IP header, see CLIENT_IP_HEADER). Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    ip_address VARCHAR(64),
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'LOCKED')),
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_login_attempts_email ON crm_login_attempts (email, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_login_attempts_ip ON crm_login_attempts (ip_address, attempted_at DESC)
    WHERE ip_address IS NOT NULL;

-- Starting values; the super admin can change them in crm_settings.
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'login_security_policy',
    '{
        "max_failures_per_email": 5,
        "max_failures_per_ip": 20,
        "window_minutes": 15,
        "retention_days": 90
    }'::jsonb,
    'Failed sign-in limits: per email and per client IP within the window; attempt history kept for retention_days'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('13', 'Admin sign-in attempt limits')
ON CONFLICT (version) DO NOTHING;
