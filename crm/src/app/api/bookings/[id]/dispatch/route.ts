import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { ASSIGNABLE_STATUSES, broadcastRideToDrivers, checkDriverEligibility } from '@/lib/dispatch-engine';
import { releasePlanReservation, reservePlanForBookingIfApplicable } from '@/lib/driver-plans';
import { notify } from '@/lib/wa-notify';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { query, withTransaction } from '@/lib/db';
import { settleReturnDiscountFunding } from '@/lib/return-trips';
import { notifyAssignment, notifyOfferedDrivers } from '@/lib/dispatch-notify';
import { issueStartOtp } from '@/lib/trip-otp';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'dispatch.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const bookingId = parseInt(params.id, 10);
    const body = await req.json();
    const { action, driver_id } = body;

    if (action === 'broadcast' || action === 'rebroadcast') {
      const result = await broadcastRideToDrivers(bookingId);
      const alerted = await notifyOfferedDrivers(bookingId, result);
      return NextResponse.json({ success: true, dispatch: result, driversAlerted: alerted });
    }

    if (action === 'force_assign') {
      if (!driver_id) {
        return NextResponse.json(
          { success: false, error: 'driver_id required for force_assign' },
          { status: 400 }
        );
      }

      const driverId = Number(driver_id);
      if (!Number.isInteger(driverId) || driverId <= 0) {
        return NextResponse.json({ success: false, error: 'Invalid driver_id' }, { status: 400 });
      }

      const outcome = await withTransaction(async (client) => {
        // Lock the booking, check it can be (re)assigned, then check the driver against the dispatch rules.
        const locked = await client.query('SELECT * FROM crm_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
        const booking = locked.rows[0];
        if (!booking) return { error: 'Booking not found', status: 404 } as const;
        const reassigning = booking.booking_status === 'DRIVER_ASSIGNED';
        if (!reassigning && !ASSIGNABLE_STATUSES.includes(booking.booking_status)) {
          return { error: `Booking #${booking.booking_code} cannot be assigned (status ${booking.booking_status}).`, status: 409 } as const;
        }
        if (reassigning && Number(booking.assigned_driver_id) === driverId) {
          return { error: 'This driver is already assigned to the booking.', status: 409 } as const;
        }

        await client.query('SELECT id FROM crm_drivers WHERE id = $1 FOR UPDATE', [driverId]);
        const eligibility = await checkDriverEligibility(client, driverId, booking);
        if (!eligibility.eligible) {
          return { error: `Driver #${driverId} cannot take this ride: ${eligibility.reasons.join('; ')}.`, status: 409 } as const;
        }

        if (reassigning) {
          await releasePlanReservation(client, bookingId, `Booking #${booking.booking_code} reassigned to driver #${driverId}`);
        }
        await settleReturnDiscountFunding(client, booking, driverId);
        await reservePlanForBookingIfApplicable(client, driverId, booking);
        await client.query(
          `UPDATE crm_bookings
           SET assigned_driver_id = $1,
               assigned_vehicle_id = $2,
               booking_status = 'DRIVER_ASSIGNED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [driverId, eligibility.vehicleId, bookingId]
        );
        // Other drivers' pending offers for this ride are closed.
        await client.query(
          `UPDATE crm_dispatch_offers SET offer_status = 'EXPIRED', responded_at = CURRENT_TIMESTAMP
           WHERE booking_id = $1 AND offer_status = 'PENDING'`,
          [bookingId]
        );
        // A new code for starting the trip; on a reassignment it replaces the previous driver's.
        const startOtp = await issueStartOtp(client, bookingId);
        return { startOtp, previousDriverId: reassigning ? Number(booking.assigned_driver_id) : null, bookingCode: booking.booking_code as string };
      });

      if ('error' in outcome) {
        return NextResponse.json({ success: false, error: outcome.error }, { status: outcome.status });
      }

      // The driver did not accept this themselves, so tell both the driver and the customer.
      await notifyAssignment(bookingId, outcome.startOtp, { notifyDriver: true });
      if (outcome.previousDriverId) {
        const prev = (await query('SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1', [outcome.previousDriverId])).rows[0];
        const phone = prev?.whatsapp_phone || prev?.phone;
        if (phone) {
          const text = `Ride #${outcome.bookingCode} has been reassigned to another driver. You no longer need to do this trip.`;
          await notify(phone, 'driver_account_notice', { params: [text], freeform: () => sendWhatsAppText(phone, text) });
        }
      }
      console.info(`[Dispatch] Booking #${bookingId} ${outcome.previousDriverId ? `reassigned from driver #${outcome.previousDriverId} ` : ''}to driver #${driverId} by admin #${auth.id}`);

      return NextResponse.json({
        success: true,
        message: `Driver #${driver_id} manually assigned to booking #${bookingId}`,
      });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action. Supported: broadcast, force_assign' },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

