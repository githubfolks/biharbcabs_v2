-- ==============================================================================
-- Migration 18: Booking cancellations and advance refunds
-- ==============================================================================
-- Agreed policy:
-- - Customer cancels at least free_cancellation_hours (2) before pickup: full refund of the online advance.
-- - Customer cancels later: no refund; BiharCabs keeps the advance (also when a driver was assigned).
-- - BiharCabs cancels (no driver, driver no-show, operational): full refund at any time.
-- - Customers cancel on WhatsApp (reply CANCEL, then confirm); staff cancel in the CRM with a reason.
-- Refunds go back to the original payment through Razorpay; a refund is booked to the ledger when
-- Razorpay reports it processed. One refund per booking. Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20),
    ADD COLUMN IF NOT EXISTS cancelled_by_admin BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS cancellation_fault VARCHAR(20),
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
    ADD COLUMN IF NOT EXISTS refund_due_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS forfeited_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

CREATE TABLE IF NOT EXISTS crm_refunds (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL UNIQUE REFERENCES crm_bookings(id) ON DELETE RESTRICT,
    provider VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
    provider_payment_id VARCHAR(64) NOT NULL,
    provider_refund_id VARCHAR(64) UNIQUE,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 100),
    -- REQUESTING -> SUBMITTING (claimed, sent to Razorpay) -> PENDING -> PROCESSED; or FAILED, which can be retried.
    status VARCHAR(20) NOT NULL DEFAULT 'REQUESTING',
    reason TEXT NOT NULL,
    last_error TEXT,
    requested_by_admin BIGINT REFERENCES crm_admin_users(id),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_refunds_status ON crm_refunds (status);

INSERT INTO crm_settings (setting_key, setting_value, description)
VALUES (
    'cancellation_policy',
    '{ "free_cancellation_hours": 2 }'::jsonb,
    'Customer cancellations at least this many hours before pickup get the online advance back in full; later ones forfeit it. BiharCabs cancellations always refund in full.'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('18', 'Booking cancellations and advance refunds')
ON CONFLICT (version) DO NOTHING;
