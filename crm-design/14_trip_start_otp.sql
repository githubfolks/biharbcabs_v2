-- ==============================================================================
-- Migration 14: Customer OTP to start a trip
-- ==============================================================================
-- When a driver is assigned, the customer gets a one-time code on WhatsApp. The driver can start the
-- trip only by entering it, which proves the customer was met. Only a hash is stored. Wrong attempts
-- are limited; the customer can ask for a new code (reply OTP), which resets the count.
-- Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS start_otp_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS start_otp_issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS start_otp_failed_attempts SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trip_started_at TIMESTAMPTZ;

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'trip_otp_policy',
    '{ "otp_digits": 4, "max_failed_attempts": 5 }'::jsonb,
    'Trip start OTP: number of digits, and wrong entries allowed before the driver must ask the customer for a new code'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('14', 'Customer OTP to start a trip')
ON CONFLICT (version) DO NOTHING;
