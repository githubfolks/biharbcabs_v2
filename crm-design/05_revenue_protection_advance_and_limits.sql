-- ==============================================================================
-- Migration 05: Revenue Protection, GST Compliance & Dynamic Credit Limits
-- ==============================================================================

-- 1. Add statutory GST & fee tracking columns to crm_bookings
ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS tech_fee_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS balance_cash_due_from_customer NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

-- 2. Seed Dynamic Revenue Protection Policy in crm_settings
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'revenue_protection_policy',
    '{
        "advance_token_percentage": 10.0,
        "min_advance_amount": 200.0,
        "platform_commission_pct": 3.0,
        "gst_on_commission_pct": 18.0,
        "tech_fee_amount": 10.0,
        "dynamic_credit_limits": {
            "probation_or_new": 300.0,
            "standard": 1000.0,
            "elite": 2500.0
        },
        "elite_min_rating": 4.80,
        "elite_min_trips": 25,
        "standard_min_rating": 4.20
    }'::jsonb,
    'Universal customer advance token rules, statutory GST parameters, and dynamic driver credit limits'
)
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;

