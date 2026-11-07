-- ==============================================================================
-- Migration 08: Return-trip priority and customer discount
-- ==============================================================================
-- Safe to run more than once: every statement is idempotent, and the policy row is only
-- inserted when missing, so values saved in CRM Settings are never overwritten.

-- Record of applied migrations, so a deploy can tell what is already in place.
CREATE TABLE IF NOT EXISTS crm_schema_migrations (
    version VARCHAR(20) PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A driver heading home after a drop. Active while ended_at is null and expires_at is in the future.
CREATE TABLE IF NOT EXISTS crm_driver_returns (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES crm_drivers(id) ON DELETE CASCADE,
    from_city VARCHAR(100) NOT NULL,
    to_city VARCHAR(100) NOT NULL,
    source_booking_id BIGINT REFERENCES crm_bookings(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    end_reason VARCHAR(40)
);
CREATE INDEX IF NOT EXISTS idx_crm_driver_returns_active ON crm_driver_returns (driver_id) WHERE ended_at IS NULL;
-- One active return per driver at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_driver_returns_one_active ON crm_driver_returns (driver_id) WHERE ended_at IS NULL;

-- Discount and funding recorded on the booking, so settlement and audits can see who paid what.
ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS fare_before_discount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS return_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS return_discount_company_share NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS return_discount_driver_share NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS return_discount_funded_by VARCHAR(20),
    ADD COLUMN IF NOT EXISTS return_exclusive_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS return_window_released_at TIMESTAMPTZ;

ALTER TABLE crm_dispatch_offers
    ADD COLUMN IF NOT EXISTS is_return_priority BOOLEAN NOT NULL DEFAULT false;

-- Feature starts switched off with no discount: the owner sets the numbers in CRM Settings.
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'return_trip_policy',
    '{"enabled": false, "discount_type": "PERCENT", "discount_value": null, "exclusive_window_minutes": 10, "return_status_hours": null}'::jsonb,
    'Return-trip priority and customer discount. Company funds the discount up to its commission; the returning driver funds the rest; the company absorbs it all if a regular driver takes the ride.'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('08', 'Return-trip priority and customer discount')
ON CONFLICT (version) DO NOTHING;
