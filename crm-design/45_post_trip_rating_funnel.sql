-- ==============================================================================
-- Migration 45: Post-Trip Rating Prompt Tracking & Support / Complaint Tickets
-- ==============================================================================

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS rating_prompt_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS crm_support_tickets (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT REFERENCES crm_bookings(id) ON DELETE SET NULL,
    customer_id BIGINT REFERENCES crm_customers(id) ON DELETE SET NULL,
    driver_id BIGINT REFERENCES crm_drivers(id) ON DELETE SET NULL,
    source VARCHAR(30) NOT NULL DEFAULT 'LOW_RATING'
        CHECK (source IN ('LOW_RATING', 'SOS', 'MANUAL')),
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL'
        CHECK (priority IN ('NORMAL', 'HIGH', 'CRITICAL')),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
    rating INTEGER,
    category VARCHAR(60),
    summary TEXT NOT NULL,
    resolution_notes TEXT,
    assigned_to BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    resolved_by BIGINT REFERENCES crm_admin_users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_support_tickets_status ON crm_support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_support_tickets_booking ON crm_support_tickets(booking_id);

-- Backfill already-completed historical bookings so the rating prompt cron only prompts newly completed rides.
UPDATE crm_bookings
SET rating_prompt_sent_at = COALESCE(trip_completed_at, updated_at, created_at)
WHERE booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
  AND rating_prompt_sent_at IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
        GRANT SELECT, INSERT, UPDATE ON crm_support_tickets TO crm_app;
        GRANT USAGE, SELECT ON SEQUENCE crm_support_tickets_id_seq TO crm_app;
    END IF;
END $$;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('45', 'Post-trip rating prompt tracking and support/complaint tickets')
ON CONFLICT (version) DO NOTHING;
