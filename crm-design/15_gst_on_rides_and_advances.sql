-- ==============================================================================
-- Migration 15: GST on ride fares, commission + tech fee, and customer advances
-- ==============================================================================
-- Per BiharCabs' CA:
-- - BiharCabs is liable for GST on the full ride fare (CGST Sec 9(5)). Fares are quoted GST-inclusive
--   at company_billing_info.tax_percentage (5%); the driver bears it (owner decision), so it is part of
--   BiharCabs' share of each ride. BiharCabs issues the only customer invoice, showing it.
-- - Commission and the tech fee charged to the driver carry 18% GST together, added on top.
-- - A customer advance carries 18% GST when received (rate not determinable at receipt).
-- Bookings created before this migration keep their amounts; ride_gst_amount stays 0 on them, so their
-- invoices still show the GST BiharCabs owes, which on those rides BiharCabs bears.
-- Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS ride_gst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS platform_commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS advance_gst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE crm_payment_links
    ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS receipt_voucher_number VARCHAR(40) UNIQUE;

-- Consecutive receipt voucher numbers for advances received.
CREATE SEQUENCE IF NOT EXISTS crm_receipt_voucher_seq;

-- 18% GST on customer advances when received; added only if not already set.
UPDATE crm_settings
SET setting_value = '{"advance_gst_pct": 18.0}'::jsonb || setting_value,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'revenue_protection_policy'
  AND NOT (setting_value ? 'advance_gst_pct');

INSERT INTO crm_schema_migrations (version, description)
VALUES ('15', 'GST on ride fares, commission + tech fee, and customer advances')
ON CONFLICT (version) DO NOTHING;
