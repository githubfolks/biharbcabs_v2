-- ==============================================================================
-- Migration 38: Round Trip Booking Support
-- ==============================================================================
-- Adds is_round_trip, return_date, and trip_days columns to crm_bookings.
-- Backward-compatible: all existing bookings default to One-Way (1 day).

ALTER TABLE crm_bookings
  ADD COLUMN IF NOT EXISTS is_round_trip BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS return_date DATE,
  ADD COLUMN IF NOT EXISTS trip_days INTEGER NOT NULL DEFAULT 1 CHECK (trip_days >= 1);

INSERT INTO crm_schema_migrations (version, description)
VALUES ('38', 'Add is_round_trip, return_date, and trip_days columns to crm_bookings')
ON CONFLICT (version) DO NOTHING;
