import { query } from './db';
import { notifyAdmins } from './wa-notify';
import { sendWhatsAppButtons } from './whatsapp';
import { getSetting } from './settings';
import { recordBookingEvent } from './booking-timeline';

export type TicketSource = 'LOW_RATING' | 'SOS' | 'MANUAL';
export type TicketPriority = 'NORMAL' | 'HIGH' | 'CRITICAL';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';

export interface CreateSupportTicketInput {
  bookingId?: number | null;
  customerId?: number | null;
  driverId?: number | null;
  source: TicketSource;
  priority?: TicketPriority;
  rating?: number | null;
  category?: string | null;
  summary: string;
  alertAdmins?: boolean;
}

/**
 * Pure funnel decision helper: determines whether a customer rating routes to
 * Google Review (high rating) or Support Ticket / Ops Callback (low rating).
 */
export function classifyRatingOutcome(
  rating: number,
  googleReviewMinStars = 4
): { route: 'GOOGLE_REVIEW' | 'COMPLAINT_TICKET'; priority: TicketPriority } {
  if (rating >= googleReviewMinStars) {
    return { route: 'GOOGLE_REVIEW', priority: 'NORMAL' };
  }
  return {
    route: 'COMPLAINT_TICKET',
    priority: rating <= 2 ? 'HIGH' : 'NORMAL',
  };
}

/**
 * Create or update an open support ticket for a booking+source (idempotent per booking & source
 * so selecting a star score then a category updates the same ticket instead of creating duplicates).
 */
export async function upsertSupportTicket(input: CreateSupportTicketInput): Promise<{ id: number; created: boolean }> {
  const priority: TicketPriority = input.priority || (input.source === 'SOS' ? 'CRITICAL' : 'NORMAL');

  if (input.bookingId && input.source === 'LOW_RATING') {
    const existing = await query(
      `SELECT id FROM crm_support_tickets
       WHERE booking_id = $1 AND source = 'LOW_RATING' AND status <> 'RESOLVED'
       ORDER BY id DESC LIMIT 1`,
      [input.bookingId]
    );
    if (existing.rows.length > 0) {
      const ticketId = Number(existing.rows[0].id);
      await query(
        `UPDATE crm_support_tickets
         SET rating = COALESCE($1, rating),
             category = COALESCE($2, category),
             priority = $3,
             summary = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [input.rating ?? null, input.category ?? null, priority, input.summary, ticketId]
      );
      return { id: ticketId, created: false };
    }
  }

  const ins = await query(
    `INSERT INTO crm_support_tickets
       (booking_id, customer_id, driver_id, source, priority, rating, category, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.bookingId ?? null,
      input.customerId ?? null,
      input.driverId ?? null,
      input.source,
      priority,
      input.rating ?? null,
      input.category ?? null,
      input.summary,
    ]
  );
  const ticketId = Number(ins.rows[0].id);

  if (input.alertAdmins) {
    const prefix = priority === 'CRITICAL' ? '🚨 CRITICAL SOS' : priority === 'HIGH' ? '⚠️ High-Priority Complaint' : '📋 Customer Feedback Ticket';
    await notifyAdmins(`${prefix} (Ticket #${ticketId}): ${input.summary}`).catch((err) =>
      console.error('[SupportTickets] Failed to alert admins:', err?.message)
    );
  }

  return { id: ticketId, created: true };
}

/**
 * Automated post-trip rating prompt worker (called from executeFrequentCronTasks).
 * Sends a 1-5 star WhatsApp prompt once for every completed booking after the configured delay
 * (default 15 minutes) if not already prompted and not yet rated.
 */
export async function runPostTripRatingPrompts(): Promise<number> {
  const policy = await getSetting<{ prompt_delay_minutes?: number }>('rating_quality_policy', {});
  const delayMinutes = Math.max(1, Number(policy?.prompt_delay_minutes ?? 15));

  const res = await query(
    `SELECT
       b.id,
       b.booking_code,
       b.origin_city,
       b.destination_city,
       c.full_name AS customer_name,
       c.phone AS customer_phone,
       d.full_name AS driver_name
     FROM crm_bookings b
     JOIN crm_customers c ON c.id = b.customer_id
     LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
     WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
       AND b.rating_prompt_sent_at IS NULL
       AND COALESCE(b.trip_completed_at, b.updated_at) <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')
       AND COALESCE(b.trip_completed_at, b.updated_at) >= CURRENT_TIMESTAMP - INTERVAL '48 hours'
       AND NOT EXISTS (SELECT 1 FROM crm_driver_ratings r WHERE r.booking_id = b.id)
     ORDER BY b.id ASC
     LIMIT 30`,
    [delayMinutes]
  );

  let sent = 0;
  for (const b of res.rows) {
    const bookingId = Number(b.id);
    // Atomically claim before sending to prevent duplicate prompts on overlapping cron runs
    const claim = await query(
      `UPDATE crm_bookings SET rating_prompt_sent_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND rating_prompt_sent_at IS NULL RETURNING id`,
      [bookingId]
    );
    if (claim.rows.length === 0) continue;

    try {
      await sendWhatsAppButtons(
        b.customer_phone,
        `Namaste ${b.customer_name || 'Traveller'}! 🙏\n\nThank you for riding with BiharCabs (#${b.booking_code}: ${b.origin_city} → ${b.destination_city || 'Local'}${b.driver_name ? ` with ${b.driver_name}` : ''}).\n\nHow was your ride experience?`,
        [
          { id: `rate_trip_${bookingId}_5`, title: '⭐⭐⭐⭐⭐ 5 Stars' },
          { id: `rate_trip_${bookingId}_4`, title: '⭐⭐⭐⭐ 4 Stars' },
          { id: `rate_trip_${bookingId}_low`, title: '⭐⭐⭐ or less' },
        ],
        'Rate Your BiharCabs Ride'
      );
      await recordBookingEvent({
        bookingId,
        eventType: 'MANUAL_NOTE',
        actorType: 'SYSTEM',
        actorLabel: 'Rating Funnel Cron',
        summary: `Post-trip rating prompt sent to customer ${b.customer_phone}`,
      });
      sent += 1;
    } catch (err: any) {
      console.error(`[RatingFunnel] Failed to send prompt for booking #${b.booking_code}:`, err?.message);
    }
  }

  return sent;
}
