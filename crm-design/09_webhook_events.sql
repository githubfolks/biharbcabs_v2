-- ==============================================================================
-- Migration 09: Webhook de-duplication
-- ==============================================================================
-- Meta retries webhook deliveries for up to 36 hours and asks receivers to de-duplicate.
-- Each WhatsApp message id is processed once. Safe to run more than once.

CREATE TABLE IF NOT EXISTS crm_schema_migrations (
    version VARCHAR(20) PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_webhook_events (
    message_id VARCHAR(255) PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_webhook_events_received ON crm_webhook_events (received_at);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('09', 'Webhook de-duplication')
ON CONFLICT (version) DO NOTHING;
