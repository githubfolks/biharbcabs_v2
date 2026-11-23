import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getPricedPackageByPublicId, CatalogError } from '@/lib/pricing-engine';
import { checkCategoryAvailability } from '@/lib/availability';
import { insertWithBookingCode } from '@/lib/booking-code';
import { broadcastRideToDrivers } from '@/lib/dispatch-engine';
import { notifyOfferedDrivers } from '@/lib/dispatch-notify';
import { notify } from '@/lib/wa-notify';
import { sendWhatsAppText } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limit: 10 bookings per IP per 10 minutes
const hits = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit = 10, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function normalizePhone(raw: unknown): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return digits;
  return '';
}

/**
 * Public booking endpoint called by WordPress when a visitor selects a CRM plan and confirms.
 * Fare is computed 100% server-side from package_public_id (client prices are never accepted).
 * Immediately creates the booking and triggers the WhatsApp confirmation & driver dispatch workflow.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ success: false, error: 'Too many booking requests. Please wait a few minutes.' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const packagePublicId = String(body.package_public_id || '').trim();
    const customerName = String(body.customer_name || '').trim().slice(0, 150);
    const customerPhone = normalizePhone(body.customer_phone);
    const customerEmail = body.customer_email ? String(body.customer_email).trim().slice(0, 150) : null;
    const originCity = String(body.origin_city || '').trim().slice(0, 100);
    const destinationCity = body.destination_city ? String(body.destination_city).trim().slice(0, 100) : null;
    const pickupAddress = String(body.pickup_address || '').trim().slice(0, 500);
    const dropAddress = body.drop_address ? String(body.drop_address).trim().slice(0, 500) : null;
    const pickupDate = String(body.pickup_date || '').trim();
    const pickupTime = String(body.pickup_time || '').trim();
    const specialNotes = body.special_notes ? String(body.special_notes).trim().slice(0, 1000) : null;

    if (!UUID_RE.test(packagePublicId)) {
      return NextResponse.json({ success: false, error: 'Invalid package_public_id.' }, { status: 400 });
    }
    if (!customerName || !customerPhone) {
      return NextResponse.json({ success: false, error: 'Valid customer name and 10-digit Indian mobile number are required.' }, { status: 400 });
    }
    if (!originCity || !pickupAddress || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || !/^\d{2}:\d{2}/.test(pickupTime)) {
      return NextResponse.json({ success: false, error: 'Origin city, pickup address, pickup date (YYYY-MM-DD), and pickup time (HH:MM) are required.' }, { status: 400 });
    }

    const pkg = await getPricedPackageByPublicId(packagePublicId);
    if (!pkg) {
      return NextResponse.json({ success: false, error: 'Selected plan is no longer available.' }, { status: 404 });
    }

    // Server-side city availability check: never confirm a public booking when 0 cabs of this category are available.
    const avail = await checkCategoryAvailability({
      originCity,
      category: pkg.cab_type.category,
      pickupDate,
      pickupTime,
    });
    if (!avail.is_available) {
      return NextResponse.json(
        {
          success: false,
          code: 'CAB_CATEGORY_UNAVAILABLE',
          error: `No ${pkg.cab_type.display_name} cab is available in ${originCity} for the selected date and time.`,
          availability: avail,
        },
        { status: 409 }
      );
    }

    const split = pkg.pricing.split;
    if (!(split.driverGrossEarnings > 0)) {
      return NextResponse.json({ success: false, error: 'Selected plan pricing is not available right now.' }, { status: 409 });
    }

    // 1. Upsert customer
    const custRes = await query(
      `INSERT INTO crm_customers (phone, full_name, email, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (phone) DO UPDATE
       SET full_name = COALESCE(EXCLUDED.full_name, crm_customers.full_name),
           email = COALESCE(EXCLUDED.email, crm_customers.email),
           updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [customerPhone, customerName, customerEmail]
    );
    const customerId = custRes.rows[0].id;

    // 2. Create booking with snapshotted rates
    const bookRes = await insertWithBookingCode((bookingCode) =>
      query(
        `INSERT INTO crm_bookings (
          booking_code, customer_id, trip_type, origin_city, destination_city,
          pickup_address, drop_address, pickup_date, pickup_time, wp_vehicle_code,
          distance_km, customer_total_fare, driver_payout_amount, commission_amount,
          gst_amount, tech_fee_amount, advance_paid, balance_cash_due_from_customer,
          booking_status, payment_status, payment_mode, advance_due_amount, advance_status,
          ride_gst_amount, platform_commission_amount,
          fare_source, rate_card_fare,
          package_id, cab_type_id, fuel_type, included_km, included_hours,
          base_fare_pre_gst, applied_gst_pct, applied_commission_pct,
          applied_extra_hour_charge, applied_extra_km_charge, special_notes, booking_source,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, 0, $12,
          'AWAITING_DRIVER', 'UNPAID', 'FULL_CASH', 0, 'NOT_REQUIRED',
          $17, $18, 'RATE_CARD', $12,
          $19, $20, $21, $22, $23,
          $24, $25, $26, $27, $28, $29, 'WORDPRESS',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING id, booking_code`,
        [
          bookingCode,
          customerId,
          pkg.booking_type,
          originCity,
          destinationCity,
          pickupAddress,
          dropAddress || destinationCity,
          pickupDate,
          pickupTime,
          pkg.cab_type.code,
          pkg.included_km,
          split.customerTotalFare,
          split.driverGrossEarnings,
          split.totalCompanyDuesZ,
          split.gstAmount,
          split.techFeeAmount,
          split.rideGstAmount,
          split.platformCommission,
          pkg.id,
          pkg.cab_type.id,
          pkg.cab_type.fuel_type,
          pkg.included_km,
          pkg.included_hours,
          split.rideTaxableValue,
          pkg.pricing.gstPct,
          pkg.pricing.commissionPct,
          pkg.cab_type.extra_hour_charge,
          pkg.cab_type.extra_km_charge,
          specialNotes,
        ]
      )
    );

    const bookingId = Number(bookRes.rows[0].id);
    const bookingCode = String(bookRes.rows[0].booking_code);

    // 3. Trigger WhatsApp workflow (customer confirmation + driver broadcast)
    const dispatch = await broadcastRideToDrivers(bookingId);
    await notifyOfferedDrivers(bookingId, dispatch);

    const confirmText =
      `Booking #${bookingCode} confirmed (${pkg.booking_type} — ${pkg.name}). ` +
      `Cab: ${pkg.cab_type.display_name}. Total Payable at drop: ₹${split.customerTotalFare.toLocaleString('en-IN')} (incl. ${pkg.pricing.gstPct}% GST). ` +
      `We are assigning your verified driver and will share driver details shortly.`;

    await notify(customerPhone, 'customer_booking_update', {
      params: [`#${bookingCode}`, confirmText],
      freeform: () => sendWhatsAppText(customerPhone, `🎉 ${confirmText}`),
    }).catch((err) => console.error(`[Public Booking] Customer WA failed for ${bookingCode}:`, err?.message));

    return NextResponse.json(
      {
        success: true,
        booking_code: bookingCode,
        plan_name: pkg.name,
        cab_name: pkg.cab_type.display_name,
        total_payment: split.customerTotalFare,
        gst_pct: pkg.pricing.gstPct,
        message: 'Booking confirmed. WhatsApp confirmation and driver assignment are in progress.',
      },
      { status: 201 }
    );
  } catch (err: any) {
    const status = err instanceof CatalogError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
