-- ==============================================================================
-- Migration 19: Refund vouchers and cancellation charges (GST, per BiharCabs' CA)
-- ==============================================================================
-- 1. A refunded customer advance was covered by a Receipt Voucher (no tax invoice), so the refund needs a
--    Refund Voucher quoting the Receipt Voucher's serial number and date (a credit note is not valid
--    without a tax invoice). Issued when Razorpay reports the refund processed, from its own
--    consecutive series, with the GST it reverses.
-- 2. An advance kept on a late cancellation is a taxable cancellation charge. Each is recorded at once;
--    its tax document is issued (own consecutive series) only when cancellation_policy
--    .cancellation_charge_gst_pct is set, which waits for the CA to confirm the rate.
-- Safe to run more than once.

ALTER TABLE crm_refunds
    ADD COLUMN IF NOT EXISTS refund_voucher_number VARCHAR(20) UNIQUE,
    ADD COLUMN IF NOT EXISTS refund_voucher_date DATE,
    ADD COLUMN IF NOT EXISTS receipt_voucher_number VARCHAR(40),
    ADD COLUMN IF NOT EXISTS receipt_voucher_date DATE,
    ADD COLUMN IF NOT EXISTS gst_reversed NUMERIC(12, 2);

CREATE SEQUENCE IF NOT EXISTS crm_refund_voucher_seq;
CREATE SEQUENCE IF NOT EXISTS crm_cancellation_invoice_seq;

CREATE TABLE IF NOT EXISTS crm_cancellation_charges (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL UNIQUE REFERENCES crm_bookings(id) ON DELETE RESTRICT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    receipt_voucher_number VARCHAR(40),
    receipt_voucher_date DATE,
    -- PENDING_RATE until the GST rate is configured; then ISSUED with its tax document.
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_RATE',
    gst_pct NUMERIC(5, 2),
    taxable_value NUMERIC(12, 2),
    gst_amount NUMERIC(12, 2),
    invoice_number VARCHAR(20) UNIQUE,
    invoice_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_cancellation_charges_status ON crm_cancellation_charges (status);

-- The cancellation charge GST rate is left empty until the CA confirms it (added only if not already set).
UPDATE crm_settings
SET setting_value = '{"cancellation_charge_gst_pct": null}'::jsonb || setting_value,
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'cancellation_policy'
  AND NOT (setting_value ? 'cancellation_charge_gst_pct');

INSERT INTO crm_schema_migrations (version, description)
VALUES ('19', 'Refund vouchers and cancellation charges')
ON CONFLICT (version) DO NOTHING;
