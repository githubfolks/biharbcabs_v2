-- ==============================================================================
-- Migration 11: Customer advance collected through Razorpay Payment Links
-- ==============================================================================
-- Before this migration, crm_bookings.advance_paid was written when a booking was created,
-- although no payment was ever taken. From now on advance_paid holds only money confirmed by a
-- signed Razorpay webhook (or 0). Existing rows are not changed; rows that already carry an
-- advance_paid amount are marked LEGACY_UNVERIFIED so staff can check them before settlement.
-- Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20),
    ADD COLUMN IF NOT EXISTS advance_due_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS advance_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS advance_waived_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS advance_waiver_reason TEXT;

-- Mark old rows once, then make the column required for new ones.
UPDATE crm_bookings
SET advance_status = CASE WHEN advance_paid > 0 THEN 'LEGACY_UNVERIFIED' ELSE 'NOT_REQUIRED' END
WHERE advance_status IS NULL;

ALTER TABLE crm_bookings
    ALTER COLUMN advance_status SET DEFAULT 'NOT_REQUIRED',
    ALTER COLUMN advance_status SET NOT NULL;

-- One row per Razorpay Payment Link created for a booking advance.
CREATE TABLE IF NOT EXISTS crm_payment_links (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES crm_bookings(id) ON DELETE RESTRICT,
    provider VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
    provider_link_id VARCHAR(64) NOT NULL UNIQUE,
    reference_id VARCHAR(40) NOT NULL UNIQUE,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 100),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    short_url TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
    provider_payment_id VARCHAR(64),
    expire_by TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_payment_links_booking ON crm_payment_links (booking_id);

-- Razorpay may deliver the same event more than once; each x-razorpay-event-id is processed once.
CREATE TABLE IF NOT EXISTS crm_payment_webhook_events (
    event_id VARCHAR(64) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Which rides must pay an advance online. Other rides let the customer choose full cash.
-- These starting values must be confirmed by the business before go-live (Settings can change them).
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'advance_collection_policy',
    '{
        "required_trip_types": ["oneway", "roundtrip"],
        "required_above_fare": 3000,
        "payment_window_minutes": 30
    }'::jsonb,
    'Rides that must pay the advance online (by trip type or fare), and minutes the customer has to pay'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('11', 'Customer advance via Razorpay Payment Links')
ON CONFLICT (version) DO NOTHING;
