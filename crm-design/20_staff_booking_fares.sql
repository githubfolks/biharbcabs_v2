-- ==============================================================================
-- Migration 20: Staff bookings priced from the rate card
-- ==============================================================================
-- Staff bookings took the fare from the request, so any fare could be booked (commission, GST and the
-- driver's earnings all follow from it). They are now priced on the server from the same WordPress rate
-- card the WhatsApp bot uses. Only the super admin may book a different fare (unlisted route or negotiated
-- price), with a reason; the rate-card fare, who changed it and why are kept on the booking.
-- Safe to run more than once.

ALTER TABLE crm_bookings
    ADD COLUMN IF NOT EXISTS fare_source VARCHAR(20),
    ADD COLUMN IF NOT EXISTS rate_card_fare NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS fare_override_by BIGINT REFERENCES crm_admin_users(id),
    ADD COLUMN IF NOT EXISTS fare_override_reason TEXT;

INSERT INTO crm_schema_migrations (version, description)
VALUES ('20', 'Staff bookings priced from the rate card')
ON CONFLICT (version) DO NOTHING;
