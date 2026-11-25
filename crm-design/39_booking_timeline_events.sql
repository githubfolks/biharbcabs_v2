-- ==============================================================================
-- Migration 39: Append-Only Ride Timeline Events & Missing Milestone Timestamps
-- ==============================================================================
-- 1. Adds driver_assigned_at, driver_arrived_at, and trip_completed_at to crm_bookings.
-- 2. Creates crm_booking_events to record every lifecycle transition with actor & metadata.
-- 3. Backfills real historical milestones from existing non-null timestamps on crm_bookings.

ALTER TABLE crm_bookings
  ADD COLUMN IF NOT EXISTS driver_assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS driver_arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trip_completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS crm_booking_events (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES crm_bookings(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  from_status VARCHAR(40),
  to_status VARCHAR(40),
  actor_type VARCHAR(24) NOT NULL CHECK (actor_type IN ('CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM')),
  actor_id BIGINT,
  actor_label VARCHAR(120),
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking_created
  ON crm_booking_events (booking_id, created_at ASC, id ASC);

-- Backfill real historical events from existing non-null columns (idempotent)
INSERT INTO crm_booking_events (booking_id, event_type, to_status, actor_type, actor_label, summary, metadata, created_at)
SELECT
  b.id,
  'BOOKING_CREATED',
  'AWAITING_DRIVER',
  CASE WHEN COALESCE(b.booking_source, 'CRM') = 'CRM' THEN 'ADMIN' ELSE 'CUSTOMER' END,
  COALESCE(b.booking_source, 'CRM'),
  'Booking #' || b.booking_code || ' created (' || b.origin_city || COALESCE(' -> ' || b.destination_city, '') || ')',
  jsonb_build_object('source', COALESCE(b.booking_source, 'CRM'), 'backfilled', true),
  b.created_at
FROM crm_bookings b
WHERE NOT EXISTS (
  SELECT 1 FROM crm_booking_events e
  WHERE e.booking_id = b.id AND e.event_type = 'BOOKING_CREATED'
);

INSERT INTO crm_booking_events (booking_id, event_type, to_status, actor_type, actor_label, summary, metadata, created_at)
SELECT
  b.id,
  'DRIVER_BROADCAST',
  'AWAITING_DRIVER',
  'SYSTEM',
  'Dispatch Engine',
  'Ride broadcasted to eligible drivers',
  jsonb_build_object('backfilled', true),
  b.driver_broadcast_at
FROM crm_bookings b
WHERE b.driver_broadcast_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM crm_booking_events e
    WHERE e.booking_id = b.id AND e.event_type = 'DRIVER_BROADCAST'
  );

INSERT INTO crm_booking_events (booking_id, event_type, to_status, actor_type, actor_label, summary, metadata, created_at)
SELECT
  b.id,
  'TRIP_STARTED',
  'TRIP_IN_PROGRESS',
  'DRIVER',
  'Assigned Driver',
  'Trip started after Start OTP verification',
  jsonb_build_object('backfilled', true),
  b.trip_started_at
FROM crm_bookings b
WHERE b.trip_started_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM crm_booking_events e
    WHERE e.booking_id = b.id AND e.event_type = 'TRIP_STARTED'
  );

INSERT INTO crm_booking_events (booking_id, event_type, to_status, actor_type, actor_label, summary, metadata, created_at)
SELECT
  b.id,
  'CANCELLED',
  'CANCELLED',
  CASE
    WHEN b.cancelled_by IN ('ADMIN', 'STAFF') THEN 'ADMIN'
    WHEN b.cancelled_by = 'CUSTOMER' THEN 'CUSTOMER'
    ELSE 'SYSTEM'
  END,
  COALESCE(b.cancelled_by, 'SYSTEM'),
  'Booking cancelled' || COALESCE(': ' || b.cancellation_reason, ''),
  jsonb_build_object('fault', b.cancellation_fault, 'backfilled', true),
  b.cancelled_at
FROM crm_bookings b
WHERE b.cancelled_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM crm_booking_events e
    WHERE e.booking_id = b.id AND e.event_type = 'CANCELLED'
  );

INSERT INTO crm_schema_migrations (version, description)
VALUES ('39', 'Add crm_booking_events timeline table and driver_assigned_at/driver_arrived_at/trip_completed_at columns')
ON CONFLICT (version) DO NOTHING;
