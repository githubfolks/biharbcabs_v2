-- ==============================================================================
-- Migration 46: Fleet Trust, Odometer Proof, Customer Tracking/SOS & Surge Pricing
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(64) UNIQUE,
    ADD COLUMN IF NOT EXISTS start_odometer_doc_id BIGINT REFERENCES crm_driver_documents(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS end_odometer_doc_id BIGINT REFERENCES crm_driver_documents(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sos_triggered_at TIMESTAMPTZ;

-- Backfill unguessable tracking tokens for existing bookings
UPDATE crm_bookings
SET tracking_token = encode(gen_random_bytes(24), 'hex')
WHERE tracking_token IS NULL;

-- Ensure new bookings get a tracking_token automatically if omitted by callers
ALTER TABLE crm_bookings
    ALTER COLUMN tracking_token SET DEFAULT encode(gen_random_bytes(24), 'hex');

CREATE INDEX IF NOT EXISTS idx_crm_bookings_tracking_token ON crm_bookings(tracking_token);

-- Peak-season / Night / Festival Surge Pricing Rules (100% DB-driven)
CREATE TABLE IF NOT EXISTS crm_pricing_rules (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    rule_type VARCHAR(30) NOT NULL DEFAULT 'FESTIVAL'
        CHECK (rule_type IN ('NIGHT', 'FESTIVAL', 'PEAK_DATE', 'CITY_DEMAND')),
    booking_type VARCHAR(30),
    origin_city VARCHAR(100),
    cab_category VARCHAR(40),
    start_date DATE,
    end_date DATE,
    start_time TIME,
    end_time TIME,
    adjustment_type VARCHAR(20) NOT NULL DEFAULT 'PERCENT'
        CHECK (adjustment_type IN ('PERCENT', 'FLAT')),
    adjustment_value NUMERIC(10, 2) NOT NULL CHECK (adjustment_value > 0),
    priority INTEGER NOT NULL DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_pricing_rules_active ON crm_pricing_rules(is_active, priority DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON crm_pricing_rules TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_pricing_rules_id_seq TO crm_app;
    END IF;
END $$;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('46', 'Fleet trust (tracking/SOS, odometer proof) and surge pricing rules')
ON CONFLICT (version) DO NOTHING;
