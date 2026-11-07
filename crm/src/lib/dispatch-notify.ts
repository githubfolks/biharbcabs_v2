import { query } from './db';
import { sendWhatsAppButtons } from './whatsapp';
import { DispatchCandidate } from './dispatch-engine';
import { formatPickup, pickupMoment } from './pickup-time';

const rupees = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Send the WhatsApp ride alert to drivers who were just offered a booking.
 * Uses the booking's stored pickup time and what each offered driver will actually earn.
 */
export async function notifyOfferedDrivers(
  bookingId: number,
  dispatch: { candidates: DispatchCandidate[]; isReturnPriority: boolean; exclusiveUntil: Date | null; offeredDriverFare: number }
): Promise<number> {
  if (dispatch.candidates.length === 0) return 0;
  const res = await query(
    `SELECT booking_code, origin_city, destination_city, wp_vehicle_code, customer_total_fare, advance_paid,
            balance_cash_due_from_customer, to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date, to_char(pickup_time, 'HH24:MI') AS pickup_time
     FROM crm_bookings WHERE id = $1`,
    [bookingId]
  );
  const b = res.rows[0];
  if (!b) return 0;

  const at = pickupMoment(b.pickup_date, b.pickup_time);
  const minutesLeft = dispatch.exclusiveUntil ? Math.max(1, Math.round((dispatch.exclusiveUntil.getTime() - Date.now()) / 60000)) : 0;
  const lines = [
    dispatch.isReturnPriority ? `🔁 Return trip home: this ride is yours alone for ${minutesLeft} min.` : null,
    `🚖 New Ride Alert (#${b.booking_code})!`,
    `Route: ${b.origin_city} → ${b.destination_city || 'Local'}`,
    `Pickup: ${at ? formatPickup(at) : `${b.pickup_date} ${b.pickup_time}`}`,
    `Cab: ${String(b.wp_vehicle_code).toUpperCase()}`,
    '',
    '💵 Fare Details:',
    `Total Fare: ${rupees(b.customer_total_fare)}`,
    `Advance Token: ${rupees(b.advance_paid)}`,
    `👉 COLLECT CASH AT DROP: ${rupees(b.balance_cash_due_from_customer)}`,
    `Your Net Earnings: ${rupees(dispatch.offeredDriverFare)}`,
    '',
    'First to tap Accept gets the ride!',
  ].filter((line) => line !== null);

  let sent = 0;
  for (const cand of dispatch.candidates) {
    const result = await sendWhatsAppButtons(
      cand.whatsapp_phone || cand.phone,
      lines.join('\n'),
      [
        { id: `accept_ride_${bookingId}`, title: '✅ Accept Ride' },
        { id: `decline_ride_${bookingId}`, title: '❌ Decline' },
      ],
      'BiharCabs Dispatch Alert'
    );
    if (result.success) sent++;
  }
  return sent;
}
