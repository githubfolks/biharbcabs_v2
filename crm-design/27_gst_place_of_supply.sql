-- ==============================================================================
-- Migration 27: Place of supply and the CGST/SGST/IGST split on ride invoices
-- ==============================================================================
-- Per BiharCabs' CA, an invoice showing one consolidated "tax" figure does not meet Rule 46 of the CGST
-- Rules. The 5% must be shown as 2.5% CGST + 2.5% SGST when the place of supply is BiharCabs' own state,
-- or 5% IGST otherwise. Place of supply (Section 12(9), IGST Act): for a registered customer, the state
-- in their GSTIN; for anyone else, the state where the passenger is picked up (owner decision: from a
-- city-to-state list in settings). An unknown city or a malformed GSTIN leaves the invoice waiting for
-- staff to choose the state on the Finance page; nothing is guessed. Safe to run more than once.

-- BiharCabs is registered in Bihar (GST state code 10). Its GSTIN, once set, must agree.
UPDATE crm_settings
SET setting_value = setting_value || '{"state_code": "10"}'::jsonb, updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'company_billing_info' AND NOT (setting_value ? 'state_code');

-- Pickup cities and their GST state codes (keys lowercase). Staff add cities from the Finance page.
INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'place_of_supply_cities',
    '{"patna": "10", "darbhanga": "10", "gaya": "10", "muzaffarpur": "10"}'::jsonb,
    'Pickup city (lowercase) to GST state code, for the place of supply of rides to unregistered customers'
)
ON CONFLICT (setting_key) DO NOTHING;

ALTER TABLE crm_invoices
    ADD COLUMN IF NOT EXISTS supplier_state_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_code CHAR(2),
    ADD COLUMN IF NOT EXISTS place_of_supply_basis VARCHAR(20)
        CHECK (place_of_supply_basis IN ('RECIPIENT_GSTIN', 'PICKUP_CITY', 'STAFF')),
    ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS place_of_supply_set_at TIMESTAMPTZ;

-- Invoices waiting for staff to choose the place of supply.
CREATE INDEX IF NOT EXISTS idx_crm_invoices_place_of_supply_pending
    ON crm_invoices (created_at) WHERE place_of_supply_code IS NULL;

-- Existing invoices, by the same rules as new ones (src/lib/place-of-supply.ts). Those that cannot be
-- known are left for staff.
WITH supplier AS (
    SELECT COALESCE(
        CASE WHEN setting_value->>'gstin' ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
             THEN substring(setting_value->>'gstin', 1, 2) END,
        setting_value->>'state_code') AS code
    FROM crm_settings WHERE setting_key = 'company_billing_info'
),
cities AS (
    SELECT setting_value AS map FROM crm_settings WHERE setting_key = 'place_of_supply_cities'
),
codes(code) AS (
    VALUES ('01'), ('02'), ('03'), ('04'), ('05'), ('06'), ('07'), ('08'), ('09'), ('10'), ('11'), ('12'),
           ('13'), ('14'), ('15'), ('16'), ('17'), ('18'), ('19'), ('20'), ('21'), ('22'), ('23'), ('24'),
           ('25'), ('26'), ('27'), ('29'), ('30'), ('31'), ('32'), ('33'), ('34'), ('35'), ('36'), ('37'),
           ('38'), ('97')
),
resolved AS (
    SELECT i.id, i.tax_amount,
           CASE WHEN COALESCE(TRIM(c.gstin), '') <> ''
                THEN CASE WHEN UPPER(TRIM(c.gstin)) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                          THEN substring(UPPER(TRIM(c.gstin)), 1, 2) END
                ELSE (SELECT map->>lower(regexp_replace(trim(split_part(b.origin_city, ',', 1)), '\s+', ' ', 'g')) FROM cities)
           END AS pos,
           CASE WHEN COALESCE(TRIM(c.gstin), '') <> '' THEN 'RECIPIENT_GSTIN' ELSE 'PICKUP_CITY' END AS basis
    FROM crm_invoices i
    JOIN crm_bookings b ON b.id = i.booking_id
    JOIN crm_customers c ON c.id = b.customer_id
    WHERE i.place_of_supply_code IS NULL
)
UPDATE crm_invoices i
SET supplier_state_code = s.code,
    place_of_supply_code = r.pos,
    place_of_supply_basis = r.basis,
    cgst_amount = CASE WHEN r.pos = s.code THEN ROUND(r.tax_amount / 2, 2) ELSE 0 END,
    sgst_amount = CASE WHEN r.pos = s.code THEN r.tax_amount - ROUND(r.tax_amount / 2, 2) ELSE 0 END,
    igst_amount = CASE WHEN r.pos = s.code THEN 0 ELSE r.tax_amount END,
    updated_at = CURRENT_TIMESTAMP
FROM resolved r, supplier s
WHERE i.id = r.id AND r.pos IN (SELECT code FROM codes) AND s.code IN (SELECT code FROM codes);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('27', 'Place of supply and CGST/SGST/IGST split on ride invoices')
ON CONFLICT (version) DO NOTHING;
