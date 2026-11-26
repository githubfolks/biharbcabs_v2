import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { calculateRideSplitWithTaxes, broadcastRideToDrivers } from '@/lib/dispatch-engine';
import { requireAdmin } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { notify } from '@/lib/wa-notify';
import { notifyOfferedDrivers } from '@/lib/dispatch-notify';
import { insertWithBookingCode } from '@/lib/booking-code';
import {
  CatalogError,
  DistanceAdjustedPricing,
  assertWithinPackageDistanceRange,
  getPricedPackageById,
  parseOptionalCoords,
  pricePackageForRoute,
} from '@/lib/pricing-engine';
import { checkCategoryAvailability } from '@/lib/availability';
import { MIN_OVERRIDE_REASON_LENGTH } from '@/lib/booking-rules';
import { DrivingDistanceResult } from '@/lib/locationiq';
import { recordBookingEvent } from '@/lib/booking-timeline';
import { assertRouteServiceable, ServiceAreaError } from '@/lib/service-area';

export const dynamic = 'force-dynamic';

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
        v.registration_no AS vehicle_reg,
        p.name AS package_name
      FROM crm_bookings b
      JOIN crm_customers c ON c.id = b.customer_id
      LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
      LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
      LEFT JOIN crm_packages p ON p.id = b.package_id
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
    return handleRouteError(err, 'API bookings');
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
      customer_email,
      package_id,
      trip_type,
      origin_city,
      destination_city,
      pickup_address,
      drop_address,
      pickup_date,
      pickup_time,
      is_round_trip = false,
      return_date,
      wp_vehicle_code,
      distance_km,
      from_lat,
      from_lon,
      to_lat,
      to_lon,
      customer_total_fare,
      auto_broadcast = true,
      fare_override_reason,
      special_notes,
    } = body;

    const fromCoords = parseOptionalCoords(from_lat, from_lon);
    const toCoords = parseOptionalCoords(to_lat, to_lon);

    if (!customer_phone || !origin_city || !pickup_date || !pickup_time) {
      return NextResponse.json(
        { success: false, error: 'Missing mandatory booking fields (customer_phone, origin_city, pickup_date, pickup_time).' },
        { status: 400 }
      );
    }

    // Reject past pickup date/time (evaluated in IST +05:30, with 1-minute grace for current minute).
    const cleanDate = String(pickup_date).trim();
    const cleanTime = String(pickup_time).trim();
    const normalizedTime = /^\d{2}:\d{2}$/.test(cleanTime) ? `${cleanTime}:00` : cleanTime;
    const pickupDateTime = new Date(`${cleanDate}T${normalizedTime}+05:30`);
    if (Number.isNaN(pickupDateTime.getTime())) {
      return NextResponse.json(
        { success: false, error: 'Invalid pickup_date or pickup_time format.' },
        { status: 400 }
      );
    }
    if (pickupDateTime.getTime() < Date.now() - 60_000) {
      return NextResponse.json(
        { success: false, error: 'Pickup date and time cannot be in the past. Please select a current or future date and time.' },
        { status: 400 }
      );
    }

    // Resolve pricing server-side from the selected CRM package (or super-admin custom fare override).
    let pkg = null;
    if (package_id !== undefined && package_id !== null && String(package_id).trim() !== '') {
      const pkgId = Number(package_id);
      if (!Number.isInteger(pkgId) || pkgId <= 0) {
        return NextResponse.json({ success: false, error: 'Invalid package_id.' }, { status: 400 });
      }
      pkg = await getPricedPackageById(pkgId);
      if (!pkg) {
        return NextResponse.json({ success: false, error: 'Selected package not found.' }, { status: 404 });
      }
    }

    let fare: number;
    let resolvedDistanceKm: number;
    let resolvedTripType: string;
    let resolvedVehicleCode: string;
    let fareSource: 'RATE_CARD' | 'OVERRIDE' = 'RATE_CARD';
    let rateCardFare: number | null = null;
    let overrideReason: string | null = null;
    let routeDistance: DrivingDistanceResult | null = null;
    let distancePricing: DistanceAdjustedPricing | null = null;
    let taxSplit;

    const requestedFare =
      customer_total_fare === undefined || customer_total_fare === null || String(customer_total_fare).trim() === ''
        ? null
        : Number(customer_total_fare);

    const isRoundTrip = Boolean(is_round_trip);
    const cleanReturnDate = isRoundTrip && return_date ? String(return_date).trim() : null;
    let resolvedTripDays = 1;

    if (pkg) {
      // Resolve road distance & distance/round-trip adjusted fare via the shared canonical pricing helper.
      const priced = await pricePackageForRoute(
        pkg,
        {
          fromCoords,
          toCoords,
          originText: origin_city,
          destinationText: destination_city || null,
          isRoundTrip,
          pickupDate: pickup_date,
          returnDate: cleanReturnDate,
        },
        'Bookings'
      );
      routeDistance = priced.routeDistance;
      distancePricing = priced.pricing;
      resolvedTripDays = distancePricing.tripDays;
      assertWithinPackageDistanceRange(pkg.name, pkg.included_km, distancePricing);
      await assertRouteServiceable({
        origin: origin_city,
        destination: destination_city || null,
      });

      rateCardFare = distancePricing.totalPayment;
      resolvedDistanceKm = distancePricing.billedKm;
      resolvedTripType = pkg.booking_type;
      resolvedVehicleCode = pkg.cab_type.code;

      const isOverride = requestedFare !== null && Math.abs(requestedFare - rateCardFare) >= 0.005;
      if (isOverride) {
        if (!hasPermission(admin.role, 'bookings.override_fare')) {
          return NextResponse.json(
            { success: false, error: `Package fare is ₹${rateCardFare.toLocaleString('en-IN')}. Only the super admin can override it.` },
            { status: 403 }
          );
        }
        const reason = String(fare_override_reason || '').trim();
        if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
          return NextResponse.json(
            { success: false, error: `A fare override needs a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.` },
            { status: 400 }
          );
        }
        if (!(requestedFare! > 0)) {
          return NextResponse.json({ success: false, error: 'Fare must be positive.' }, { status: 400 });
        }
        fare = requestedFare!;
        fareSource = 'OVERRIDE';
        overrideReason = reason;
        taxSplit = await calculateRideSplitWithTaxes(fare);
      } else {
        fare = rateCardFare;
        taxSplit = distancePricing.split;
      }
    } else {
      // No package selected: super-admin custom fare only
      if (!wp_vehicle_code) {
        return NextResponse.json({ success: false, error: 'Select a booking package or provide wp_vehicle_code.' }, { status: 400 });
      }
      if (!hasPermission(admin.role, 'bookings.override_fare')) {
        return NextResponse.json(
          { success: false, error: 'Please select a configured package. Only the super admin can create a custom-fare booking.' },
          { status: 403 }
        );
      }
      if (!requestedFare || !(requestedFare > 0)) {
        return NextResponse.json({ success: false, error: 'Custom booking requires a positive fare.' }, { status: 400 });
      }
      const reason = String(fare_override_reason || '').trim();
      if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
        return NextResponse.json(
          { success: false, error: `A custom fare needs a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.` },
          { status: 400 }
        );
      }
      fare = requestedFare;
      resolvedDistanceKm = Number(distance_km) > 0 ? Number(distance_km) : 0;
      resolvedTripType = String(trip_type || 'OUTSTATION').toUpperCase();
      resolvedVehicleCode = String(wp_vehicle_code);
      fareSource = 'OVERRIDE';
      overrideReason = reason;
      taxSplit = await calculateRideSplitWithTaxes(fare);
    }

    if (!(taxSplit.driverGrossEarnings > 0)) {
      return NextResponse.json(
        { success: false, error: "This fare does not cover BiharCabs' share and GST; the driver would earn nothing." },
        { status: 400 }
      );
    }

    // Enforce live Cab Category availability in the source city (unless explicitly overridden by staff for waitlist/manual dispatch).
    const allowUnavailable = Boolean(body.allow_unavailable);
    const cabCategory = pkg ? pkg.cab_type.category : resolvedVehicleCode;
    const avail = await checkCategoryAvailability({
      originCity: origin_city,
      category: cabCategory,
      pickupDate: pickup_date,
      pickupTime: pickup_time,
    });
    if (!avail.is_available && !allowUnavailable) {
      return NextResponse.json(
        {
          success: false,
          code: 'CAB_CATEGORY_UNAVAILABLE',
          error: `No ${pkg ? pkg.cab_type.display_name : cabCategory} cab is currently available in ${origin_city} for ${pickup_date} ${pickup_time}.`,
          availability: avail,
        },
        { status: 409 }
      );
    }

    // 1. Upsert customer
    const cleanPhone = String(customer_phone).replace(/\D/g, '');
    const custRes = await query(
      `INSERT INTO crm_customers (phone, full_name, email, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (phone) DO UPDATE
       SET full_name = COALESCE(EXCLUDED.full_name, crm_customers.full_name),
           email = COALESCE(EXCLUDED.email, crm_customers.email),
           updated_at = CURRENT_TIMESTAMP
       RETURNING id, full_name, phone`,
      [cleanPhone, customer_name || 'Customer', customer_email || null]
    );
    const customer = custRes.rows[0];

    const initialStatus = auto_broadcast ? 'AWAITING_DRIVER' : 'CONFIRMED_AWAITING_DRIVER';

    // 2. Insert booking with snapshotted package & cab rates (no advance payment)
    const bookRes = await insertWithBookingCode((bookingCode) =>
      query(
        `INSERT INTO crm_bookings (
          booking_code, customer_id, trip_type, origin_city, destination_city,
          pickup_address, drop_address, pickup_date, pickup_time, wp_vehicle_code,
          distance_km, customer_total_fare, driver_payout_amount, commission_amount,
          gst_amount, tech_fee_amount, advance_paid, balance_cash_due_from_customer,
          booking_status, payment_status, payment_mode, advance_due_amount, advance_status,
          ride_gst_amount, platform_commission_amount,
          fare_source, rate_card_fare, fare_override_by, fare_override_reason,
          package_id, cab_type_id, fuel_type, included_km, included_hours,
          base_fare_pre_gst, applied_gst_pct, applied_commission_pct,
          applied_extra_hour_charge, applied_extra_km_charge, special_notes, booking_source,
          is_round_trip, return_date, trip_days,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, 0, $12,
          $17, 'UNPAID', 'FULL_CASH', 0, 'NOT_REQUIRED',
          $18, $19, $20, $21, $22, $23,
          $24, $25, $26, $27, $28,
          $29, $30, $31, $32, $33, $34, 'CRM',
          $35, $36, $37,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING *`,
        [
          bookingCode,
          customer.id,
          resolvedTripType,
          origin_city,
          destination_city || null,
          pickup_address || `${origin_city} Central`,
          drop_address || destination_city || null,
          pickup_date,
          pickup_time,
          resolvedVehicleCode,
          resolvedDistanceKm,
          fare,
          taxSplit.driverGrossEarnings,
          taxSplit.totalCompanyDuesZ,
          taxSplit.gstAmount,
          taxSplit.techFeeAmount,
          initialStatus,
          taxSplit.rideGstAmount,
          taxSplit.platformCommission,
          fareSource,
          rateCardFare,
          fareSource === 'OVERRIDE' ? admin.id : null,
          overrideReason,
          pkg?.id ?? null,
          pkg?.cab_type.id ?? null,
          pkg?.cab_type.fuel_type ?? null,
          pkg?.included_km ?? null,
          pkg?.included_hours ?? null,
          taxSplit.rideTaxableValue,
          pkg?.pricing.gstPct ?? null,
          pkg?.pricing.commissionPct ?? null,
          pkg?.cab_type.extra_hour_charge ?? null,
          pkg?.cab_type.extra_km_charge ?? null,
          special_notes || null,
          isRoundTrip,
          cleanReturnDate,
          resolvedTripDays,
        ]
      )
    );

    const booking = bookRes.rows[0];
    const bookingCode: string = booking.booking_code;

    await recordBookingEvent({
      bookingId: Number(booking.id),
      eventType: 'BOOKING_CREATED',
      toStatus: initialStatus,
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.full_name || admin.email || `Admin #${admin.id}`,
      summary: `Booking #${bookingCode} created via CRM (${origin_city}${destination_city ? ` → ${destination_city}` : ''}${isRoundTrip ? `, Round Trip ${resolvedTripDays}d` : ''})`,
      metadata: {
        source: 'CRM',
        tripType: resolvedTripType,
        packageName: pkg?.name ?? null,
        cab: pkg ? pkg.cab_type.display_name : resolvedVehicleCode,
        customerTotalFare: fare,
        isRoundTrip,
        tripDays: resolvedTripDays,
      },
    });

    // 3. Trigger WhatsApp workflow: notify customer & broadcast to matching verified drivers
    let dispatchResult = null;
    if (auto_broadcast) {
      dispatchResult = await broadcastRideToDrivers(Number(booking.id));
      await notifyOfferedDrivers(Number(booking.id), dispatchResult);
    }

    const roundTripLabel = isRoundTrip
      ? ` • Round Trip (${resolvedTripDays} ${resolvedTripDays === 1 ? 'day' : 'days'}${cleanReturnDate ? `, return ${cleanReturnDate}` : ''})`
      : '';
    const customerText =
      `Booking #${bookingCode} confirmed (${resolvedTripType}${roundTripLabel}${pkg ? ` — ${pkg.name}` : ''}). ` +
      `Cab: ${pkg ? pkg.cab_type.display_name : resolvedVehicleCode.toUpperCase()}. ` +
      `Total Payable at drop: ₹${fare.toLocaleString('en-IN')} (incl. GST & platform charge). We are assigning your verified driver now.`;

    await notify(cleanPhone, 'customer_booking_update', {
      params: [`#${bookingCode}`, customerText],
      freeform: () => sendWhatsAppText(cleanPhone, `🎉 ${customerText}`),
    }).catch((err) => console.error(`[Bookings] Customer WA notification failed for ${bookingCode}:`, err?.message));

    return NextResponse.json({
      success: true,
      booking,
      dispatch: dispatchResult,
      route_distance: routeDistance,
      distance_pricing: distancePricing,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API bookings');
  }
}
