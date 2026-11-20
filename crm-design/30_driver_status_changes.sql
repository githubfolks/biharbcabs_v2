-- ==============================================================================
-- Migration 30: Manual driver status changes, with a record of who and why
-- ==============================================================================
-- Drivers are suspended automatically for expired documents (SUSPENDED_DOC_EXPIRED) or repeated 1-star
-- ratings (SUSPENDED_QUALITY), but nothing could lift those, and staff could not suspend or offboard a
-- driver. Staff with drivers.manage can now (owner decision):
--   ACTIVATE  PENDING_DOCS, SUSPENDED_DOC_EXPIRED, SUSPENDED_QUALITY, SUSPENDED_MANUAL or OFFBOARDED
--             -> APPROVED_ACTIVE, only when the licence and every vehicle's insurance, fitness and
--             permit dates are entered and not in the past. Dues statuses are lifted by paying dues.
--   SUSPEND   -> SUSPENDED_MANUAL (new status)
--   OFFBOARD  -> OFFBOARDED (new status)
-- Every change needs a written reason and is recorded here with the admin who made it.
-- New drivers (CRM form and WhatsApp sign-up) now start as PENDING_DOCS with unverified vehicles.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_driver_status_changes (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE RESTRICT,
    action VARCHAR(20) NOT NULL CHECK (action IN ('ACTIVATE', 'SUSPEND', 'OFFBOARD')),
    from_status VARCHAR(50) NOT NULL,
    to_status VARCHAR(50) NOT NULL,
    reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
    changed_by BIGINT NOT NULL REFERENCES crm_admin_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_driver_status_changes_driver
    ON crm_driver_status_changes (driver_id, created_at DESC);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('30', 'Manual driver status changes')
ON CONFLICT (version) DO NOTHING;
