-- ==============================================================================
-- Migration 29: Send GST documents to customers on WhatsApp
-- ==============================================================================
-- Per BiharCabs' CA, customers must be given their tax invoices, receipt vouchers, refund vouchers and
-- cancellation charge invoices (Section 31, CGST Act). The frequent cron job sends each as a PDF on
-- WhatsApp: a document message inside the 24-hour window, otherwise the customer_gst_document template
-- with the PDF in its header. Each document records its delivery:
--   PENDING   waiting to be sent (also while BiharCabs' GSTIN or its place of supply is missing)
--   SENT      delivered to WhatsApp
--   FAILED    not sent after gst_document_delivery.max_attempts tries; listed under Failed messages
--   NOT_SENT  issued before this migration: never sent automatically (owner decision); finance can
--             download it from the CRM
-- Safe to run more than once: only documents that exist when the column is first added become NOT_SENT.

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['crm_invoices', 'crm_payment_links', 'crm_refunds', 'crm_cancellation_charges'] LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wa_delivery_status VARCHAR(10)', t);
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wa_sent_at TIMESTAMPTZ', t);
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wa_attempts INTEGER NOT NULL DEFAULT 0', t);
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wa_last_error TEXT', t);
        -- Existing rows (status still NULL) are documents issued before delivery existed.
        EXECUTE format('UPDATE %I SET wa_delivery_status = ''NOT_SENT'' WHERE wa_delivery_status IS NULL', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN wa_delivery_status SET DEFAULT ''PENDING''', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN wa_delivery_status SET NOT NULL', t);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_wa_delivery_status_check') THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (wa_delivery_status IN (''PENDING'', ''SENT'', ''FAILED'', ''NOT_SENT''))',
                           t, t || '_wa_delivery_status_check');
        END IF;
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (id) WHERE wa_delivery_status = ''PENDING''', 'idx_' || t || '_wa_pending', t);
    END LOOP;
END $$;

-- Payment links that are not receipt vouchers (unpaid, driver dues) are not customer documents.
UPDATE crm_payment_links SET wa_delivery_status = 'NOT_SENT'
WHERE wa_delivery_status = 'PENDING' AND (receipt_voucher_number IS NULL OR purpose <> 'ADVANCE');

-- The approved template's name (see crm-design/whatsapp_templates.md); existing names are kept.
UPDATE crm_settings
SET setting_value = '{"customer_gst_document": "bc_customer_gst_document"}'::jsonb || setting_value, updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'whatsapp_templates' AND NOT (setting_value ? 'customer_gst_document');

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES ('gst_document_delivery', '{"max_attempts": 3}'::jsonb,
        'Tries to send each GST document on WhatsApp before it is marked FAILED and listed under Failed messages')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('29', 'Send GST documents to customers on WhatsApp')
ON CONFLICT (version) DO NOTHING;
