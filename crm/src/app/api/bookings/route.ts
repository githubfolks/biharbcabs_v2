import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calculateRideSplitWithTaxes, broadcastRideToDrivers } from '@/lib/dispatch-engine';
import { requireAdmin } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { getAdvanceCollectionPolicy } from '@/lib/settings';
import { MIN_WAIVER_REASON_LENGTH, advanceLinkMessage, isAdvanceRequired, requestAdvancePayment } from '@/lib/advance-payments';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { notify } from '@/lib/wa-notify';
import { notifyOfferedDrivers } from '@/lib/dispatch-notify';
import { insertWithBookingCode } from '@/lib/booking-code';

export const dynamic = 'force-dynamic';

/** How staff settle the advance on a booking they create. */
const ADVANCE_MODES = ['PAYMENT_LINK', 'FULL_CASH', 'WAIVED'] as const;
type AdvanceMode = (typeof ADVANCE_MODES)[number];

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    let sql = `
      SELECT 
        b.*,
        c.full_name AS customer_name,
        c.phone AS customer_phone,
        d.full_name AS driver_name,
        d.phone AS driver_phone,
        d.onboarding_status AS driver_status,
        v.model_name AS vehicle_model,
        v.registration_no AS vehicle_reg
      FROM crm_bookings b
      JOIN crm_customers c ON c.id = b.customer_id
      LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
      LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
    `;

    const params: any[] = [];
    if (status) {
      params.push(status);
      sql += ` WHERE b.booking_status = $1`;
    }

    sql += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query(sql, params);
    return NextResponse.json({ success: true, bookings: res.rows });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.create');
  if (auth instanceof NextResponse) return auth;
  const admin = auth;
  try {
    const body = await req.json();
    const {
      customer_phone,
      customer_name,
      trip_type,
      origin_city,
      destination_city,
      pickup_address,
      drop_address,
      pickup_date,
      pickup_time,
      wp_vehicle_code,
      distance_km,
      customer_total_fare,
      auto_broadcast,
      advance_mode,
      advance_waiver_reason,
    } = body;

    if (!customer_phone || !origin_city || !pickup_date || !pickup_time || !wp_vehicle_code) {
      return NextResponse.json(
        { success: false, error: 'Missing mandatory booking fields' },
        { status: 400 }
      );
    }

    if (!ADVANCE_MODES.includes(advance_mode)) {
      return NextResponse.json(
        { success: false, error: `advance_mode must be one of: ${ADVANCE_MODES.join(', ')}` },
        { status: 400 }
      );
    }
    const mode = advance_mode as AdvanceMode;
    const waiverReason = typeof advance_waiver_reason === 'string' ? advance_waiver_reason.trim() : '';
    if (mode === 'WAIVED' && !hasPermission(admin.role, 'bookings.waive_advance')) {
      console.warn(`[Auth] Admin #${admin.id} (${admin.role}) denied bookings.waive_advance`);
      return NextResponse.json({ success: false, error: 'Your role cannot waive the customer advance' }, { status: 403 });
    }
    if (mode === 'WAIVED' && waiverReason.length < MIN_WAIVER_REASON_LENGTH) {
      return NextResponse.json(
        { success: false, error: `A waiver needs a reason of at least ${MIN_WAIVER_REASON_LENGTH} characters.` },
        { status: 400 }
      );
    }
    const fareInput = Number(customer_total_fare || 0);
    if (!(fareInput > 0)) {
      return NextResponse.json({ success: false, error: 'customer_total_fare must be greater than 0' }, { status: 400 });
    }
    const advancePolicy = await getAdvanceCollectionPolicy();
    const required = isAdvanceRequired(advancePolicy, trip_type || 'oneway', fareInput);
    if (mode === 'FULL_CASH' && required) {
      return NextResponse.json(
        { success: false, error: 'This ride needs the advance online. Send a payment link, or waive it with a reason.' },
        { status: 400 }
      );
    }

    // 1. Upsert customer
    const cleanPhone = customer_phone.replace(/\D/g, '');
    const custRes = await query(
      `INSERT INTO crm_customers (phone, full_name, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (phone) DO UPDATE
       SET full_name = COALESCE(EXCLUDED.full_name, crm_customers.full_name),
           updated_at = CURRENT_TIMESTAMP
       RETURNING id, full_name, phone`,
      [cleanPhone, customer_name || 'Customer']
    );
    const customer = custRes.rows[0];

    // 2. Calculate dynamic commission, statutory GST, tech fee, advance token and driver payout
    const fare = fareInput;
    const taxSplit = await calculateRideSplitWithTaxes(fare);

    // advance_paid stays 0 until Razorpay confirms the money; a link booking waits for it.
    const viaLink = mode === 'PAYMENT_LINK';
    const advanceDue = viaLink ? taxSplit.advanceTokenAmount : 0;
    const balanceDue = Math.max(0, fare - advanceDue);
    const readyStatus = auto_broadcast ? 'AWAITING_DRIVER' : 'CONFIRMED_AWAITING_DRIVER';
    const initialStatus = viaLink ? 'AWAITING_ADVANCE' : readyStatus;
    const advanceStatus = viaLink ? 'PENDING' : mode === 'WAIVED' ? 'WAIVED' : 'NOT_REQUIRED';

    // 4. Insert booking with revenue protection & tax fields
    // A fresh, unguessable code; retried in the rare case it is already taken.
    const bookRes = await insertWithBookingCode((bookingCode) => query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, trip_type, origin_city, destination_city,
        pickup_address, drop_address, pickup_date, pickup_time, wp_vehicle_code,
        distance_km, customer_total_fare, driver_payout_amount, commission_amount,
        gst_amount, tech_fee_amount, advance_paid, balance_cash_due_from_customer,
        booking_status, payment_status, payment_mode, advance_due_amount, advance_status,
        advance_waived_by, advance_waiver_reason, ride_gst_amount, platform_commission_amount, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, $17, $18, 'PENDING', $19, $20, $21, $22, $23, $24, $25, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        bookingCode,
        customer.id,
        trip_type || 'oneway',
        origin_city,
        destination_city || null,
        pickup_address || `${origin_city} Central`,
        drop_address || destination_city || null,
        pickup_date,
        pickup_time,
        wp_vehicle_code,
        distance_km || 0,
        fare,
        taxSplit.driverGrossEarnings,
        taxSplit.totalCompanyDuesZ,
        taxSplit.gstAmount,
        taxSplit.techFeeAmount,
        balanceDue,
        initialStatus,
        viaLink ? 'ADVANCE_ONLINE' : 'FULL_CASH',
        advanceDue,
        advanceStatus,
        mode === 'WAIVED' ? admin.id : null,
        mode === 'WAIVED' ? waiverReason : null,
        taxSplit.rideGstAmount,
        taxSplit.platformCommission,
      ]
    ));
    const bookingCode: string = bookRes.rows[0].booking_code;

    const booking = bookRes.rows[0];

    if (mode === 'WAIVED') {
      console.info(`[Bookings] Advance waived on ${bookingCode} by admin #${admin.id} (advance was ${required ? 'required' : 'optional'}).`);
    }

    if (viaLink) {
      // Drivers see this booking only after the payment webhook confirms the advance.
      try {
        const request = await requestAdvancePayment(Number(booking.id));
        // Staff bookings: the customer may never have messaged us, so outside the window this is a template.
        const linkText = await advanceLinkMessage(bookingCode, request, balanceDue);
        await notify(cleanPhone, 'customer_payment_link', {
          params: [
            `₹${request.amount.toLocaleString('en-IN')}`,
            `#${bookingCode}`,
            request.shortUrl,
            Math.max(1, Math.round((request.expireBy.getTime() - Date.now()) / 60000)),
            `₹${balanceDue.toLocaleString('en-IN')}`,
          ],
          freeform: () => sendWhatsAppText(cleanPhone, linkText),
        });
        return NextResponse.json({ success: true, booking, payment_link_url: request.shortUrl, dispatch: null });
      } catch (err: any) {
        return NextResponse.json(
          { success: false, error: `Booking ${bookingCode} saved but the payment link failed: ${err.message}`, booking_code: bookingCode },
          { status: 502 }
        );
      }
    }

    let dispatchResult = null;
    if (auto_broadcast) {
      dispatchResult = await broadcastRideToDrivers(booking.id);
      await notifyOfferedDrivers(Number(booking.id), dispatchResult);
    }

    return NextResponse.json({
      success: true,
      booking,
      dispatch: dispatchResult,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
