-- ==============================================================================
-- Migration 12: Recording money paid out to drivers
-- ==============================================================================
-- A positive wallet_balance is money BiharCabs owes the driver (e.g. an advance that exceeded
-- BiharCabs' share). Until now nothing recorded actually paying it. A payout is a
-- DRIVER_PAYOUT_SENT ledger entry that lowers the wallet, with who recorded it and the UPI/bank
-- reference. The same reference can be recorded only once per channel. Safe to run more than once.

ALTER TABLE crm_payments_ledger
    ADD COLUMN IF NOT EXISTS recorded_by BIGINT REFERENCES crm_admin_users(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ledger_payout_reference
    ON crm_payments_ledger (payment_channel, reference_id)
    WHERE transaction_type = 'DRIVER_PAYOUT_SENT';

INSERT INTO crm_schema_migrations (version, description)
VALUES ('12', 'Driver payout recording')
ON CONFLICT (version) DO NOTHING;
