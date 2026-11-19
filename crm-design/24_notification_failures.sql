-- ==============================================================================
-- Migration 24: Failed WhatsApp notifications
-- ==============================================================================
-- A WhatsApp message BiharCabs starts (ride offer, trip OTP, payment link, assignment, reminders) that
-- fails to send was only written to the message log or the server console, so nobody followed it up.
-- Each failure is now recorded here. Admins get one summary per frequent cron run (alerted_at), and staff
-- mark each one handled from the dispatch board (resolved_at, resolved_by).
--
-- Message contents are deliberately NOT stored: some contain the customer's trip OTP. Only which message
-- it was, who it was for, the booking code where there is one, and the error. Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_notification_failures (
    id BIGSERIAL PRIMARY KEY,
    template_key VARCHAR(64) NOT NULL,
    -- NULL when the send raised an error before a channel was chosen.
    channel VARCHAR(16) CHECK (channel IN ('FREEFORM', 'TEMPLATE')),
    phone VARCHAR(20) NOT NULL,
    booking_code VARCHAR(32),
    error TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    alerted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolved_by BIGINT REFERENCES crm_admin_users(id)
);

-- The dispatch board lists open failures; the cron claims ones not yet in a summary.
CREATE INDEX IF NOT EXISTS idx_notification_failures_open
    ON crm_notification_failures (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_failures_unalerted
    ON crm_notification_failures (id) WHERE alerted_at IS NULL;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('24', 'Failed WhatsApp notifications')
ON CONFLICT (version) DO NOTHING;
