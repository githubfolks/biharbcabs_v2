-- ==============================================================================
-- Migration 17: Recording driver dues payments
-- ==============================================================================
-- A negative wallet_balance is what the driver owes BiharCabs. Drivers were told to pay by UPI and
-- "reply with the UTR", but nothing recorded the money, so a driver who paid stayed restricted.
-- Now a dues payment is a DRIVER_DUES_PAYMENT ledger entry that raises the wallet, either from a
-- Razorpay link the driver pays (confirmed by the signed webhook) or recorded by finance for UPI to the
-- company VPA, bank transfer or cash. Payment links can belong to a driver's dues instead of a booking.
-- Safe to run more than once.

ALTER TABLE crm_payment_links
    ALTER COLUMN booking_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'ADVANCE',
    ADD COLUMN IF NOT EXISTS driver_id BIGINT REFERENCES crm_drivers(id) ON DELETE RESTRICT;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_crm_payment_links_owner') THEN
        ALTER TABLE crm_payment_links ADD CONSTRAINT chk_crm_payment_links_owner CHECK (
            (purpose = 'ADVANCE' AND booking_id IS NOT NULL)
            OR (purpose = 'DRIVER_DUES' AND driver_id IS NOT NULL AND booking_id IS NULL)
        );
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_crm_payment_links_driver ON crm_payment_links (driver_id) WHERE driver_id IS NOT NULL;

-- The same UTR / bank reference / receipt number can be recorded only once per channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ledger_dues_reference
    ON crm_payments_ledger (payment_channel, reference_id)
    WHERE transaction_type = 'DRIVER_DUES_PAYMENT';

INSERT INTO crm_schema_migrations (version, description)
VALUES ('17', 'Driver dues payment recording')
ON CONFLICT (version) DO NOTHING;
