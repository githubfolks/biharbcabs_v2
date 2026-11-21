-- ==============================================================================
-- Migration 31: Editing drivers and vehicles, with a record of each change
-- ==============================================================================
-- After onboarding, nothing could change a driver's details, vehicles or document dates. Staff can now
-- (owner decisions):
--   * edit a driver's name, phones, city, licence number and licence expiry (drivers.manage);
--   * edit payout details, UPI ID, bank account and IFSC (drivers.payout_details: super admin and finance);
--   * add a vehicle: all three document dates required and not past; entering them counts as checking
--     the documents, so the vehicle is verified at once;
--   * edit a vehicle's category, model and document dates (the registration number is not editable);
--   * remove a vehicle: kept for ride history, marked removed. Dispatch, the expiry suspension and the
--     expiry reminders ignore removed vehicles. A vehicle on an open ride cannot be removed.
-- Every change is recorded in crm_driver_edits with the admin and the old and new values.
-- Safe to run more than once.

ALTER TABLE crm_driver_vehicles
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS removed_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS removed_reason TEXT;

CREATE TABLE IF NOT EXISTS crm_driver_edits (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE RESTRICT,
    vehicle_id BIGINT REFERENCES crm_driver_vehicles(id) ON DELETE RESTRICT,
    action VARCHAR(30) NOT NULL CHECK (action IN ('DRIVER_EDIT', 'PAYOUT_DETAILS_EDIT', 'VEHICLE_ADD', 'VEHICLE_EDIT', 'VEHICLE_REMOVE')),
    -- { "field": { "from": old, "to": new }, ... } for the fields that changed
    changes JSONB NOT NULL,
    reason TEXT,
    changed_by BIGINT NOT NULL REFERENCES crm_admin_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_driver_edits_driver ON crm_driver_edits (driver_id, created_at DESC);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('31', 'Driver and vehicle editing')
ON CONFLICT (version) DO NOTHING;
