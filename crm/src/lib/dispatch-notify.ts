import { query } from './db';
import { sendWhatsAppButtons, sendWhatsAppText } from './whatsapp';
import { otpMessage } from './trip-otp';
import { DispatchCandidate } from './dispatch-engine';
import { formatPickup, pickupMoment } from './pickup-time';
import { notify, notifyAdmins } from './wa-notify';

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
    `👉 COLLECT CASH AT DROP: ${rupees(b.customer_total_fare)}`,
    `Your Net Earnings: ${rupees(dispatch.offeredDriverFare)}`,
    '',
    'First to tap Accept gets the ride!',
  ].filter((line) => line !== null);

  let sent = 0;
  for (const cand of dispatch.candidates) {
    const phone = cand.whatsapp_phone || cand.phone;
    const result = await notify(phone, 'driver_ride_alert', {
      ref: bookingId,
      params: [
        `#${b.booking_code}${dispatch.isReturnPriority ? ` (return trip: yours alone for ${minutesLeft} min)` : ''}`,
        `${b.origin_city} to ${b.destination_city || 'Local'}`,
        at ? formatPickup(at) : `${b.pickup_date} ${b.pickup_time}`,
        String(b.wp_vehicle_code).toUpperCase(),
        rupees(b.balance_cash_due_from_customer),
        rupees(dispatch.offeredDriverFare),
      ],
      freeform: () =>
        sendWhatsAppButtons(
          phone,
          lines.join('\n'),
          [
            { id: `accept_ride_${bookingId}`, title: '✅ Accept Ride' },
            { id: `decline_ride_${bookingId}`, title: '❌ Decline' },
          ],
          'BiharCabs Dispatch Alert'
        ),
    });
    if (result.success) sent++;
  }

  // Nobody reached: tell admins now rather than at the SLA escalation.
  if (sent === 0) {
    await notifyAdmins(`Ride #${b.booking_code} (${b.origin_city} to ${b.destination_city || 'Local'}) was offered to ${dispatch.candidates.length} driver(s) but no WhatsApp alert was delivered. Assign it manually.`);
  }
  return sent;
}

/**
 * Tell the customer their driver is assigned, with the trip OTP; optionally tell the driver too (when
 * the assignment did not come from the driver's own tap, e.g. a staff force-assign). The OTP goes only
 * to the customer. Outside the 24-hour window the approved templates are used.
 */
export async function notifyAssignment(bookingId: number, startOtp: string | undefined, opts: { notifyDriver: boolean }): Promise<void> {
  const res = await query(
    `SELECT b.id, b.booking_code, b.origin_city, b.destination_city, b.pickup_address, b.wp_vehicle_code,
            b.customer_total_fare, b.advance_paid, b.driver_payout_amount,
            to_char(b.pickup_date, 'YYYY-MM-DD') AS pickup_date, to_char(b.pickup_time, 'HH24:MI') AS pickup_time,
            c.phone AS customer_phone, c.full_name AS customer_name,
            d.full_name AS driver_name, d.phone AS driver_phone, d.whatsapp_phone AS driver_whatsapp,
            v.registration_no
     FROM crm_bookings b
     JOIN crm_customers c ON c.id = b.customer_id
     JOIN crm_drivers d ON d.id = b.assigned_driver_id
     LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const b = res.rows[0];
  if (!b) return;
  const at = pickupMoment(b.pickup_date, b.pickup_time);
  const when = at ? formatPickup(at) : `${b.pickup_date} ${b.pickup_time}`;
  const cash = rupees(Number(b.customer_total_fare || 0));
  const cab = `${String(b.wp_vehicle_code).toUpperCase()}${b.registration_no ? ` ${b.registration_no}` : ''}`;

  if (b.customer_phone) {
    const confirmation =
      `✅ Booking Confirmed (#${b.booking_code})!\nYour cab for ${b.origin_city} to ${b.destination_city || 'destination'} is locked.\n\n` +
      `Driver: ${b.driver_name}\nDriver Phone: ${b.driver_phone}\nCab: ${cab}\nPickup Location: ${b.pickup_address}\nScheduled: ${when}\n` +
      `Total Fare (payable to driver at drop): ${cash}\n\nYour driver will arrive 10 minutes prior to pickup.`;
    await notify(b.customer_phone, 'customer_driver_assigned', {
      params: [`#${b.booking_code}`, b.driver_name, b.driver_phone, cab, b.pickup_address, when, cash, startOtp || 'reply OTP to get it'],
      freeform: async () => {
        const first = await sendWhatsAppText(b.customer_phone, confirmation);
        if (startOtp) await sendWhatsAppText(b.customer_phone, otpMessage(b.booking_code, startOtp));
        return first;
      },
    });
  }

  if (opts.notifyDriver) {
    const driverPhone = b.driver_whatsapp || b.driver_phone;
    const customer = `${b.customer_name || 'Passenger'} (${b.customer_phone})`;
    await notify(driverPhone, 'driver_trip_assigned', {
      ref: Number(b.id),
      params: [`#${b.booking_code}`, b.pickup_address, when, customer, cash],
      freeform: () =>
        sendWhatsAppButtons(
          driverPhone,
          `🚖 BiharCabs assigned you Trip #${b.booking_code}\nPickup: ${b.pickup_address}\nWhen: ${when}\nCustomer: ${customer}\n\n💵 COLLECT CASH AT DROP: ${cash}\nYour Net Payout: ${rupees(b.driver_payout_amount)}\n\n🔐 At pickup, tap Start Trip and enter the OTP the customer received.`,
          [{ id: `start_trip_${b.id}`, title: '🚀 Start Trip' }],
          'Trip Assigned'
        ),
    });
  }
}
