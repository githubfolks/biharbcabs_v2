import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { consumeRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { upsertSupportTicket } from '@/lib/support-tickets';
import { recordBookingEvent } from '@/lib/booking-timeline';

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

/**
 * 1-Tap Customer Safety SOS Trigger.
 * Logs SOS_TRIGGERED on Ride Timeline, opens a CRITICAL support ticket, and alerts Ops via WhatsApp.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = String(params.token || '').trim();
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ success: false, error: 'Invalid trip link.' }, { status: 400 });
  }

  // Strict per-token rate limit (3 SOS alerts per 10 minutes)
  const rl = consumeRateLimit(`pub:sos:${token}`, 3);
  if (!rl.allowed) {
    return rateLimitExceededResponse(rl, 'SOS alert already sent to Operations. Please call support directly.');
  }

  try {
    const body = await req.json().catch(() => ({}));
    const note = String(body?.note || '').trim().slice(0, 300);

    const res = await query(
      `SELECT b.id, b.booking_code, b.customer_id, b.assigned_driver_id, b.origin_city, b.destination_city,
              c.full_name AS customer_name, c.phone AS customer_phone,
              d.full_name AS driver_name, d.phone AS driver_phone
       FROM crm_bookings b
       JOIN crm_customers c ON c.id = b.customer_id
       LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
       WHERE b.tracking_token = $1
       LIMIT 1`,
      [token]
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Trip not found.' }, { status: 404 });
    }
    const b = res.rows[0];
    const bookingId = Number(b.id);

    await query(`UPDATE crm_bookings SET sos_triggered_at = CURRENT_TIMESTAMP WHERE id = $1`, [bookingId]);

    const summary = `SOS triggered on #${b.booking_code} (${b.origin_city} → ${b.destination_city || 'Local'}) by ${b.customer_name || 'Customer'} (${b.customer_phone})${b.driver_name ? ` | Driver: ${b.driver_name} (${b.driver_phone})` : ''}${note ? ` | Note: ${note}` : ''}`;

    const ticket = await upsertSupportTicket({
      bookingId,
      customerId: Number(b.customer_id),
      driverId: b.assigned_driver_id ? Number(b.assigned_driver_id) : null,
      source: 'SOS',
      priority: 'CRITICAL',
      category: 'SAFETY_SOS',
      summary,
      alertAdmins: true,
    });

    await recordBookingEvent({
      bookingId,
      eventType: 'SOS_TRIGGERED',
      actorType: 'CUSTOMER',
      actorLabel: b.customer_name || 'Customer',
      summary: `Emergency SOS triggered by customer${note ? `: ${note}` : ''}`,
      metadata: { ticketId: ticket.id },
    });

    return NextResponse.json({
      success: true,
      ticket_id: ticket.id,
      message: 'Emergency SOS alert sent to BiharCabs Operations Desk. Our team is calling you immediately.',
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
