-- ==============================================================================
-- Migration 28: Place of supply and CGST/SGST/IGST on receipt, refund and cancellation documents
-- ==============================================================================
-- Per BiharCabs' CA, receipt vouchers (Rule 50), refund vouchers (Rule 51) and cancellation charge tax
-- invoices must be issued to customers, and like ride invoices (migration 27) they show the tax split by
-- place of supply (Section 12(9), IGST Act):
--   RV (crm_payment_links): worked out when the advance is received (customer GSTIN, else pickup city).
--   RF (crm_refunds): the place of supply of the receipt voucher it reverses.
--   CC (crm_cancellation_charges): that of its receipt voucher; worked out on its own only when it has none.
-- Unknown places of supply wait for finance (Finance page); setting a receipt voucher's also fills in its
-- refund vouchers and cancellation charges. A receipt voucher now records the GST rate it was issued at.
-- Safe to run more than once.

ALTER TABLE crm_payment_links
    ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS supplier_state_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_basis VARCHAR(20)
        CHECK (place_of_supply_basis IN ('RECIPIENT_GSTIN', 'PICKUP_CITY', 'STAFF')),
    ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_at TIMESTAMPTZ;

ALTER TABLE crm_refunds
    ADD COLUMN IF NOT EXISTS supplier_state_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_basis VARCHAR(20)
        CHECK (place_of_supply_basis IN ('RECEIPT_VOUCHER')),
    ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12, 2);

ALTER TABLE crm_cancellation_charges
    ADD COLUMN IF NOT EXISTS supplier_state_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_basis VARCHAR(20)
        CHECK (place_of_supply_basis IN ('RECEIPT_VOUCHER', 'RECIPIENT_GSTIN', 'PICKUP_CITY', 'STAFF')),
    ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_at TIMESTAMPTZ;

-- The rate each existing receipt voucher was issued at, from its own amounts (GST included).
UPDATE crm_payment_links
SET gst_pct = ROUND(gst_amount * 100 / (amount_paise / 100.0 - gst_amount), 2)
WHERE gst_pct IS NULL AND gst_amount IS NOT NULL AND amount_paise / 100.0 > gst_amount;

-- The same rules as src/lib/place-of-supply.ts, for filling in documents already issued.
CREATE OR REPLACE FUNCTION pg_temp.bc_valid_state(code TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT code IN ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18',
                    '19','20','21','22','23','24','25','26','27','29','30','31','32','33','34','35','36','37','38','97')
$$;
CREATE OR REPLACE FUNCTION pg_temp.bc_supplier_state() RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        CASE WHEN setting_value->>'gstin' ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
             THEN substring(setting_value->>'gstin', 1, 2) END,
        setting_value->>'state_code')
    FROM crm_settings WHERE setting_key = 'company_billing_info'
$$;
-- Place of supply for a booking: registered customer's GSTIN state, else the pickup city's; NULL if unknown.
CREATE OR REPLACE FUNCTION pg_temp.bc_booking_pos(p_booking BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN COALESCE(TRIM(c.gstin), '') <> ''
                THEN CASE WHEN UPPER(TRIM(c.gstin)) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                          THEN substring(UPPER(TRIM(c.gstin)), 1, 2) END
                ELSE (SELECT setting_value->>lower(regexp_replace(trim(split_part(b.origin_city, ',', 1)), '\s+', ' ', 'g'))
                      FROM crm_settings WHERE setting_key = 'place_of_supply_cities')
           END
    FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE b.id = p_booking
$$;
CREATE OR REPLACE FUNCTION pg_temp.bc_booking_basis(p_booking BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN COALESCE(TRIM(c.gstin), '') <> '' THEN 'RECIPIENT_GSTIN' ELSE 'PICKUP_CITY' END
    FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE b.id = p_booking
$$;

-- Receipt vouchers.
UPDATE crm_payment_links l
SET supplier_state_code = pg_temp.bc_supplier_state(),
    place_of_supply_code = pg_temp.bc_booking_pos(l.booking_id),
    place_of_supply_basis = pg_temp.bc_booking_basis(l.booking_id),
    cgst_amount = CASE WHEN pg_temp.bc_booking_pos(l.booking_id) = pg_temp.bc_supplier_state() THEN ROUND(l.gst_amount / 2, 2) ELSE 0 END,
    sgst_amount = CASE WHEN pg_temp.bc_booking_pos(l.booking_id) = pg_temp.bc_supplier_state() THEN l.gst_amount - ROUND(l.gst_amount / 2, 2) ELSE 0 END,
    igst_amount = CASE WHEN pg_temp.bc_booking_pos(l.booking_id) = pg_temp.bc_supplier_state() THEN 0 ELSE l.gst_amount END,
    updated_at = CURRENT_TIMESTAMP
WHERE l.receipt_voucher_number IS NOT NULL AND l.gst_amount IS NOT NULL AND l.booking_id IS NOT NULL
  AND l.place_of_supply_code IS NULL
  AND pg_temp.bc_valid_state(pg_temp.bc_booking_pos(l.booking_id)) AND pg_temp.bc_valid_state(pg_temp.bc_supplier_state());

-- Refund vouchers: as their receipt voucher.
UPDATE crm_refunds r
SET supplier_state_code = l.supplier_state_code,
    place_of_supply_code = l.place_of_supply_code,
    place_of_supply_basis = 'RECEIPT_VOUCHER',
    cgst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN ROUND(r.gst_reversed / 2, 2) ELSE 0 END,
    sgst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN r.gst_reversed - ROUND(r.gst_reversed / 2, 2) ELSE 0 END,
    igst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN 0 ELSE r.gst_reversed END,
    updated_at = CURRENT_TIMESTAMP
FROM crm_payment_links l
WHERE r.refund_voucher_number IS NOT NULL AND r.gst_reversed IS NOT NULL AND r.place_of_supply_code IS NULL
  AND l.receipt_voucher_number = r.receipt_voucher_number AND l.place_of_supply_code IS NOT NULL;

-- Cancellation charges with a receipt voucher: as that voucher.
UPDATE crm_cancellation_charges c
SET supplier_state_code = l.supplier_state_code,
    place_of_supply_code = l.place_of_supply_code,
    place_of_supply_basis = 'RECEIPT_VOUCHER',
    cgst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN ROUND(c.gst_amount / 2, 2) ELSE 0 END,
    sgst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN c.gst_amount - ROUND(c.gst_amount / 2, 2) ELSE 0 END,
    igst_amount = CASE WHEN l.place_of_supply_code = l.supplier_state_code THEN 0 ELSE c.gst_amount END,
    updated_at = CURRENT_TIMESTAMP
FROM crm_payment_links l
WHERE c.status = 'ISSUED' AND c.gst_amount IS NOT NULL AND c.place_of_supply_code IS NULL
  AND l.receipt_voucher_number = c.receipt_voucher_number AND l.place_of_supply_code IS NOT NULL;

-- Cancellation charges without a receipt voucher: worked out for the booking.
UPDATE crm_cancellation_charges c
SET supplier_state_code = pg_temp.bc_supplier_state(),
    place_of_supply_code = pg_temp.bc_booking_pos(c.booking_id),
    place_of_supply_basis = pg_temp.bc_booking_basis(c.booking_id),
    cgst_amount = CASE WHEN pg_temp.bc_booking_pos(c.booking_id) = pg_temp.bc_supplier_state() THEN ROUND(c.gst_amount / 2, 2) ELSE 0 END,
    sgst_amount = CASE WHEN pg_temp.bc_booking_pos(c.booking_id) = pg_temp.bc_supplier_state() THEN c.gst_amount - ROUND(c.gst_amount / 2, 2) ELSE 0 END,
    igst_amount = CASE WHEN pg_temp.bc_booking_pos(c.booking_id) = pg_temp.bc_supplier_state() THEN 0 ELSE c.gst_amount END,
    updated_at = CURRENT_TIMESTAMP
WHERE c.status = 'ISSUED' AND c.gst_amount IS NOT NULL AND c.place_of_supply_code IS NULL AND c.receipt_voucher_number IS NULL
  AND pg_temp.bc_valid_state(pg_temp.bc_booking_pos(c.booking_id)) AND pg_temp.bc_valid_state(pg_temp.bc_supplier_state());

INSERT INTO crm_schema_migrations (version, description)
VALUES ('28', 'Place of supply and GST split on receipt, refund and cancellation documents')
ON CONFLICT (version) DO NOTHING;
