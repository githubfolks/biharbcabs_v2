-- ==============================================================================
-- Migration 22: Reconcile payment links whose expiry webhook never arrived
-- ==============================================================================
-- A booking waiting for its advance was closed only by Razorpay's payment_link.expired webhook; if that
-- webhook was lost, the booking stayed AWAITING_ADVANCE forever. The frequent job now asks Razorpay
-- about links still CREATED well past expire_by and closes expired/cancelled ones the same way the webhook
-- does. A link Razorpay reports as paid is never confirmed from that alone (only the signed webhook does);
-- admins are alerted once, recorded in reconcile_alerted_at. Safe to run more than once.

ALTER TABLE crm_payment_links
    ADD COLUMN IF NOT EXISTS reconcile_alerted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_payment_links_open_expiry
    ON crm_payment_links (expire_by) WHERE status = 'CREATED';

INSERT INTO crm_schema_migrations (version, description)
VALUES ('22', 'Reconcile payment links whose expiry webhook never arrived')
ON CONFLICT (version) DO NOTHING;
