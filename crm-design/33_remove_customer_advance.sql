-- ==============================================================================
-- Migration 33: Remove customer advance payment system (non-destructive)
-- ==============================================================================
-- Customer advance collection is retired. Historical columns (crm_bookings.advance_paid,
-- advance_status, crm_payment_links rows with purpose='ADVANCE', crm_refunds,
-- crm_cancellation_charges) are preserved read-only for accounting and GST audit trails.
-- Driver dues Razorpay links (purpose='DRIVER_DUES') remain active.
-- Safe to run more than once.

-- 1. Remove customer advance settings keys.
DELETE FROM crm_settings
WHERE setting_key IN ('advance_collection_policy', 'advance_token_amount');

-- 2. Strip advance-only keys from revenue_protection_policy and disable digital-only soft mode
--    (which relied on customer advance-paid rides).
UPDATE crm_settings
SET setting_value = (
        setting_value
        - 'advance_token_percentage'
        - 'min_advance_amount'
        - 'advance_gst_pct'
    ) || jsonb_build_object(
        'enable_digital_only_soft_mode', false,
        'payment_link_window_minutes', COALESCE((setting_value->>'payment_link_window_minutes')::int, 30)
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy';

-- 3. Remove obsolete duplicate commission_model setting if revenue_protection_policy exists,
--    preserving its percentage only if revenue_protection_policy lacks platform_commission_pct.
UPDATE crm_settings r
SET setting_value = jsonb_set(
        r.setting_value,
        '{platform_commission_pct}',
        COALESCE(r.setting_value->'platform_commission_pct', c.setting_value->'percentage', '12'::jsonb)
    ),
    updated_at = CURRENT_TIMESTAMP
FROM crm_settings c
WHERE r.setting_key = 'revenue_protection_policy'
  AND c.setting_key = 'commission_model'
  AND NOT (r.setting_value ? 'platform_commission_pct');

DELETE FROM crm_settings WHERE setting_key = 'commission_model';

-- 4. Ensure new bookings default to FULL_CASH / NOT_REQUIRED.
ALTER TABLE crm_bookings
    ALTER COLUMN payment_mode SET DEFAULT 'FULL_CASH',
    ALTER COLUMN advance_status SET DEFAULT 'NOT_REQUIRED',
    ALTER COLUMN advance_due_amount SET DEFAULT 0.00;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('33', 'Remove customer advance payment system (non-destructive)')
ON CONFLICT (version) DO NOTHING;
