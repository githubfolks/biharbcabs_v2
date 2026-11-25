import { PoolClient } from 'pg';
import { query } from './db';

export type BookingEventType =
  | 'BOOKING_CREATED'
  | 'DRIVER_BROADCAST'
  | 'DRIVER_OFFER_DECLINED'
  | 'DRIVER_ASSIGNED'
  | 'DRIVER_REASSIGNED'
  | 'START_OTP_ISSUED'
  | 'START_OTP_FAILED'
  | 'START_OTP_LOCKED'
  | 'WAKEUP_SENT'
  | 'WAKEUP_CONFIRMED'
  | 'WAKEUP_ALERTED'
  | 'DRIVER_ARRIVED'
  | 'TRIP_STARTED'
  | 'TRIP_COMPLETED'
  | 'SLA_ESCALATED'
  | 'CANCELLED'
  | 'MANUAL_NOTE';

export type BookingEventActorType = 'CUSTOMER' | 'DRIVER' | 'ADMIN' | 'SYSTEM';

export interface RecordBookingEventInput {
  bookingId: number;
  eventType: BookingEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorType: BookingEventActorType;
  actorId?: number | null;
  actorLabel?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface BookingTimelineEvent {
  id: number;
  booking_id: number;
  event_type: BookingEventType;
  from_status: string | null;
  to_status: string | null;
  actor_type: BookingEventActorType;
  actor_id: number | null;
  actor_label: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

type QueryExecutor = Pick<PoolClient, 'query'>;

/**
 * Append a chronological event to crm_booking_events.
 * Pass `client` when running inside a database transaction so the event commits atomically
 * with the booking state change.
 */
export async function recordBookingEvent(
  input: RecordBookingEventInput,
  client?: QueryExecutor
): Promise<void> {
  const sql = `
    INSERT INTO crm_booking_events (
      booking_id, event_type, from_status, to_status,
      actor_type, actor_id, actor_label, summary, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `;
  const params = [
    input.bookingId,
    input.eventType,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.actorType,
    input.actorId ?? null,
    input.actorLabel ?? null,
    input.summary,
    JSON.stringify(input.metadata ?? {}),
  ];

  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

export async function getBookingTimeline(bookingId: number) {
  const bookingRes = await query(
    `SELECT
       b.id, b.booking_code, b.booking_status, b.payment_status, b.trip_type,
       b.origin_city, b.destination_city, b.pickup_address, b.drop_address,
       b.pickup_date, b.pickup_time, b.is_round_trip, b.return_date, b.trip_days,
       b.wp_vehicle_code, b.customer_total_fare, b.driver_payout_amount,
       b.booking_source, b.created_at, b.driver_broadcast_at, b.sla_deadline_at,
       b.driver_assigned_at, b.driver_arrived_at, b.start_otp_issued_at,
       b.wakeup_sent_at, b.wakeup_confirmed_at, b.wakeup_alerted_at,
       b.trip_started_at, b.trip_completed_at, b.cancelled_at, b.cancellation_reason,
       c.full_name AS customer_name, c.phone AS customer_phone,
       d.id AS driver_id, d.full_name AS driver_name, d.phone AS driver_phone,
       v.registration_no AS vehicle_reg, v.model_name AS vehicle_model
     FROM crm_bookings b
     LEFT JOIN crm_customers c ON c.id = b.customer_id
     LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
     LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
     WHERE b.id = $1`,
    [bookingId]
  );

  const booking = bookingRes.rows[0];
  if (!booking) return null;

  const [eventsRes, offersRes] = await Promise.all([
    query(
      `SELECT id, booking_id, event_type, from_status, to_status,
              actor_type, actor_id, actor_label, summary, metadata, created_at
       FROM crm_booking_events
       WHERE booking_id = $1
       ORDER BY created_at ASC, id ASC`,
      [bookingId]
    ),
    query(
      `SELECT o.id, o.driver_id, o.offer_status, o.sent_at, o.responded_at,
              d.full_name AS driver_name, d.phone AS driver_phone
       FROM crm_dispatch_offers o
       LEFT JOIN crm_drivers d ON d.id = o.driver_id
       WHERE o.booking_id = $1
       ORDER BY o.sent_at ASC, o.id ASC`,
      [bookingId]
    ),
  ]);

  return {
    booking,
    events: eventsRes.rows as BookingTimelineEvent[],
    offers: offersRes.rows,
  };
}
