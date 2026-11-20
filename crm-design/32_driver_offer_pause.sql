-- ==============================================================================
-- Migration 32: Pausing a driver's ride offers
-- ==============================================================================
-- Staff could only take a driver off rides by suspending them. They can now pause ride offers (driver on
-- leave, car in the garage) without changing the driver's status (owner decision). The pause is its own
-- flag, not is_available: settlement, dues payments, incentives and activation all set is_available back
-- to true, which would quietly undo a pause. A pause lasts until staff resume it. Dispatch refuses a
-- paused driver ("ride offers are paused by staff"), for broadcasts and staff assignment alike.
-- Pausing and resuming need a reason and are recorded in crm_driver_edits (OFFERS_PAUSE, OFFERS_RESUME).
-- Safe to run more than once.

ALTER TABLE crm_drivers
    ADD COLUMN IF NOT EXISTS offers_paused BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS offers_paused_reason TEXT,
    ADD COLUMN IF NOT EXISTS offers_paused_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offers_paused_by BIGINT REFERENCES crm_admin_users(id);

ALTER TABLE crm_driver_edits DROP CONSTRAINT IF EXISTS crm_driver_edits_action_check;
ALTER TABLE crm_driver_edits ADD CONSTRAINT crm_driver_edits_action_check CHECK (action IN (
    'DRIVER_EDIT', 'PAYOUT_DETAILS_EDIT', 'VEHICLE_ADD', 'VEHICLE_EDIT', 'VEHICLE_REMOVE',
    'OFFERS_PAUSE', 'OFFERS_RESUME'
));

INSERT INTO crm_schema_migrations (version, description)
VALUES ('32', 'Pausing driver ride offers')
ON CONFLICT (version) DO NOTHING;
