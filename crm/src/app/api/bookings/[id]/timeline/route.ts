import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { getBookingTimeline, recordBookingEvent } from '@/lib/booking-timeline';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'bookings.view');
  if (auth instanceof NextResponse) return auth;

  const bookingId = Number(params.id);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid booking id' }, { status: 400 });
  }

  try {
    const timeline = await getBookingTimeline(bookingId);
    if (!timeline) {
      return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...timeline });
  } catch (err: any) {
    return handleRouteError(err, 'API bookings/[id]/timeline');
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'dispatch.manage');
  if (auth instanceof NextResponse) return auth;

  const bookingId = Number(params.id);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid booking id' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const action = String(body?.action || '').trim();
    const note = typeof body?.note === 'string' ? body.note.trim() : '';

    if (action !== 'mark_driver_arrived' && action !== 'add_note') {
      return NextResponse.json(
        { success: false, error: 'Supported actions: mark_driver_arrived, add_note' },
        { status: 400 }
      );
    }

    if (action === 'add_note' && note.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Note must be at least 2 characters.' },
        { status: 400 }
      );
    }

    const actorLabel = auth.full_name || auth.email || `Admin #${auth.id}`;

    const outcome = await withTransaction(async (client) => {
      const bRes = await client.query('SELECT id, booking_status, driver_arrived_at FROM crm_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      const booking = bRes.rows[0];
      if (!booking) return { error: 'Booking not found', status: 404 } as const;

      if (action === 'mark_driver_arrived') {
        if (booking.booking_status !== 'DRIVER_ASSIGNED') {
          return {
            error: `Driver arrival can only be marked while status is DRIVER_ASSIGNED (currently ${booking.booking_status}).`,
            status: 409,
          } as const;
        }
        await client.query(
          `UPDATE crm_bookings
           SET driver_arrived_at = COALESCE(driver_arrived_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [bookingId]
        );
        await recordBookingEvent(
          {
            bookingId,
            eventType: 'DRIVER_ARRIVED',
            fromStatus: booking.booking_status,
            toStatus: booking.booking_status,
            actorType: 'ADMIN',
            actorId: auth.id,
            actorLabel,
            summary: note ? `Driver arrived at pickup — ${note}` : 'Driver arrived at pickup location',
            metadata: note ? { note } : {},
          },
          client
        );
        return { ok: true } as const;
      }

      await recordBookingEvent(
        {
          bookingId,
          eventType: 'MANUAL_NOTE',
          actorType: 'ADMIN',
          actorId: auth.id,
          actorLabel,
          summary: note,
        },
        client
      );
      return { ok: true } as const;
    });

    if ('error' in outcome) {
      return NextResponse.json({ success: false, error: outcome.error }, { status: outcome.status });
    }

    const timeline = await getBookingTimeline(bookingId);
    return NextResponse.json({ success: true, ...timeline });
  } catch (err: any) {
    return handleRouteError(err, 'API bookings/[id]/timeline');
  }
}
