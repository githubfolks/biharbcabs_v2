-- ==============================================================================
-- Migration 26: GST document numbering per CA, and the cancellation charge rate
-- ==============================================================================
-- Per BiharCabs' CA:
-- 1. A customer advance kept on a late cancellation is taxed at 5%, the rate of the passenger transport
--    service itself (CBIC Circular No. 178/10/2022-GST). Set only if no rate is configured yet.
-- 2. Ride tax invoices must be one consecutive series of at most 16 characters (Rule 46(b), CGST Rules).
--    They were INV-<booking code>-<4 clock digits>. They are now TI<financial year><6-digit serial>,
--    e.g. TI2627000001 (12 characters). Invoices issued earlier keep their numbers.
-- 4. Every series restarts at 000001 on 1 April, so a year's first and last serials match the number of
--    documents issued (GSTR-1 Table 13).
--
-- Numbers now come from crm_document_counters, one row per series per financial year, incremented in
-- the same transaction as the document: a failed transaction gives its number back, so a series has no
-- gaps (database sequences can leave gaps on rollback). This financial year's counters continue from
-- the highest number already issued, so no number is reused. The old sequences (crm_receipt_voucher_seq,
-- crm_refund_voucher_seq, crm_cancellation_invoice_seq) are no longer used and are left in place.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_document_counters (
    series VARCHAR(4) NOT NULL,
    financial_year CHAR(4) NOT NULL,
    last_number INTEGER NOT NULL CHECK (last_number >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, financial_year)
);

-- Continue each year's series from the highest number already issued in it (never lower a counter).
INSERT INTO crm_document_counters (series, financial_year, last_number)
SELECT series, fy, MAX(serial)
FROM (
    SELECT 'RV' AS series, substring(receipt_voucher_number, 3, 4) AS fy, substring(receipt_voucher_number, 7)::int AS serial
    FROM crm_payment_links WHERE receipt_voucher_number ~ '^RV[0-9]{10}$'
    UNION ALL
    SELECT 'RF', substring(refund_voucher_number, 3, 4), substring(refund_voucher_number, 7)::int
    FROM crm_refunds WHERE refund_voucher_number ~ '^RF[0-9]{10}$'
    UNION ALL
    SELECT 'CC', substring(invoice_number, 3, 4), substring(invoice_number, 7)::int
    FROM crm_cancellation_charges WHERE invoice_number ~ '^CC[0-9]{10}$'
    UNION ALL
    SELECT 'TI', substring(invoice_number, 3, 4), substring(invoice_number, 7)::int
    FROM crm_invoices WHERE invoice_number ~ '^TI[0-9]{10}$'
) issued
GROUP BY series, fy
ON CONFLICT (series, financial_year) DO UPDATE
SET last_number = GREATEST(crm_document_counters.last_number, EXCLUDED.last_number),
    updated_at = CURRENT_TIMESTAMP;

-- Excess GST on a kept advance. GST was paid at 18% when the advance was received (rate not determinable
-- at receipt); the cancellation charge it becomes is taxed at 5%. Per CA, the difference cannot be
-- adjusted in GSTR-3B: it is reclaimed with Form GST RFD-01 ("Refund of excess payment of tax",
-- Section 54 of the CGST Act). Each charge records the GST paid at receipt on the kept amount and the
-- excess, so finance can claim it. Both stay NULL when the GST paid at receipt is not recorded.
ALTER TABLE crm_cancellation_charges
    ADD COLUMN IF NOT EXISTS advance_gst_paid NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS excess_gst NUMERIC(12, 2);

-- Charges already issued: the GST paid at receipt, in proportion to the part of the advance kept.
UPDATE crm_cancellation_charges c
SET advance_gst_paid = ROUND(l.gst_amount * (c.amount * 100) / l.amount_paise, 2),
    excess_gst = ROUND(l.gst_amount * (c.amount * 100) / l.amount_paise, 2) - c.gst_amount,
    updated_at = CURRENT_TIMESTAMP
FROM crm_payment_links l
WHERE c.status = 'ISSUED' AND c.advance_gst_paid IS NULL AND c.gst_amount IS NOT NULL
  AND l.receipt_voucher_number = c.receipt_voucher_number
  AND l.gst_amount IS NOT NULL AND l.amount_paise > 0;

-- 5% on a kept advance, only where no rate has been configured.
UPDATE crm_settings
SET setting_value = jsonb_set(setting_value, '{cancellation_charge_gst_pct}', '5'::jsonb),
    updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'cancellation_policy'
  AND COALESCE(setting_value->'cancellation_charge_gst_pct', 'null'::jsonb) = 'null'::jsonb;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('26', 'GST document numbering per CA, cancellation charge rate 5%')
ON CONFLICT (version) DO NOTHING;
