-- ==============================================================================
-- Migration 42: Customer CRM Tags/Notes & Unassigned Ride Auto-Rebroadcast
-- ==============================================================================

ALTER TABLE crm_customers
    ADD COLUMN IF NOT EXISTS tag VARCHAR(20) NOT NULL DEFAULT 'REGULAR',
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_customers_tag ON crm_customers(tag);

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS auto_rebroadcast_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_rebroadcast_at TIMESTAMPTZ;

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'unassigned_rebroadcast_policy',
    '{"enabled": true, "after_minutes": 5, "max_rebroadcasts": 1}'::jsonb,
    'Automatically re-broadcast unassigned AWAITING_DRIVER bookings to newly available drivers after X minutes before SLA escalation.'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('42', 'Customer CRM tags/notes and unassigned ride auto-rebroadcast')
ON CONFLICT (version) DO NOTHING;
