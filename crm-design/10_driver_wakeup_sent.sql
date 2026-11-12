-- ==============================================================================
-- Migration 10: Driver wake-up reminder marker
-- ==============================================================================
-- The scheduled job (/api/dispatch/cron) sends each assigned driver one wake-up reminder before
-- pickup and records the time in crm_bookings.wakeup_sent_at. No earlier migration created this
-- column, so on a database built from migrations every scheduled run failed at the wake-up step.
-- Matches the column already present on databases where it was added by hand. Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_schema_migrations (
    version VARCHAR(20) PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE crm_bookings ADD COLUMN IF NOT EXISTS wakeup_sent_at TIMESTAMPTZ;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('10', 'Driver wake-up reminder marker')
ON CONFLICT (version) DO NOTHING;
