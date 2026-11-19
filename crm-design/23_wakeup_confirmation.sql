-- ==============================================================================
-- Migration 23: Driver wake-up confirmation and follow-up
-- ==============================================================================
-- Before a pickup the driver gets a wake-up check ("I am ready"). Tapping it recorded nothing and nobody
-- followed up a driver who did not answer. Now the driver's confirmation is recorded, and if an assigned
-- driver has not confirmed by wakeup_unconfirmed_alert_minutes before pickup (60, owner decision), admins
-- are alerted once, at least 15 minutes after the check was sent. Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS wakeup_confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wakeup_alerted_at TIMESTAMPTZ;

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'driver_wakeup_unconfirmed_alert_minutes',
    '{ "value": 60 }'::jsonb,
    'Alert admins if the assigned driver has not confirmed the wake-up check this many minutes before pickup'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('23', 'Driver wake-up confirmation and follow-up')
ON CONFLICT (version) DO NOTHING;
