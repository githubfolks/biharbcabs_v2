import { NextRequest, NextResponse } from 'next/server';
import {
  calculateDistanceAdjustedPricing,
  listPricedPackages,
  parseOptionalCoords,
  resolveRouteDistanceSafely,
} from '@/lib/pricing-engine';
import { BOOKING_TYPES } from '@/lib/booking-rules';
import { getCityCabAvailability } from '@/lib/availability';
import { getSplitRules } from '@/lib/settings';

export const dynamic = 'force-dynamic';

// Simple per-IP in-memory rate limiter (60 requests per 10 minutes)
const hits = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit = 60, windowMs = 10 * 60 * 1000): boolean {
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

/**
 * Public read-only endpoint consumed by the WordPress frontend to display
 * configured cabs and booking plans. Never exposes internal integer IDs.
 */
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ success: false, error: 'Too many requests. Please try again shortly.' }, { status: 429 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const rawType = searchParams.get('booking_type');
    const originCity = searchParams.get('origin_city')?.trim() || '';
    const destinationCity = searchParams.get('destination_city')?.trim() || '';
    const pickupDate = searchParams.get('pickup_date');
    const pickupTime = searchParams.get('pickup_time');
    const fromCoords = parseOptionalCoords(searchParams.get('from_lat'), searchParams.get('from_lon'));
    const toCoords = parseOptionalCoords(searchParams.get('to_lat'), searchParams.get('to_lon'));
    const bookingType = rawType ? rawType.trim().toUpperCase() : null;
    if (bookingType && !BOOKING_TYPES.includes(bookingType as any)) {
      return NextResponse.json(
        { success: false, error: `booking_type must be one of: ${BOOKING_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    const [packages, availMap, routeDistance, splitRules] = await Promise.all([
      listPricedPackages({
        activeOnly: true,
        bookingType,
        skipUnpriceable: true,
      }),
      originCity ? getCityCabAvailability({ originCity, pickupDate, pickupTime }) : Promise.resolve(null),
      resolveRouteDistanceSafely(
        { fromCoords, toCoords, originText: originCity, destinationText: destinationCity },
        'Public Plans'
      ),
      getSplitRules(),
    ]);

    const publicPlans = packages
      .map((p) => {
        const cat = p.cab_type.category.toUpperCase();
        const availability = availMap
          ? (availMap[cat] ?? {
              city: originCity,
              category: cat,
              total_cabs: 0,
              available_cabs: 0,
              is_available: false,
            })
          : null;
        const effective = calculateDistanceAdjustedPricing(
          p.pricing,
          p.included_km,
          p.cab_type.extra_km_charge,
          routeDistance?.distance_km ?? null,
          splitRules
        );
        return {
          public_id: p.public_id,
          name: p.name,
          booking_type: p.booking_type,
          sub_type: p.sub_type,
          included_km: p.included_km,
          included_hours: p.included_hours,
          description: p.description,
          cab: {
            public_id: p.cab_type.public_id,
            code: p.cab_type.code,
            category: p.cab_type.category,
            display_name: p.cab_type.display_name,
            fuel_type: p.cab_type.fuel_type,
            seating_capacity: p.cab_type.seating_capacity,
            luggage_bags: p.cab_type.luggage_bags,
            models_description: p.cab_type.models_description,
            extra_hour_charge: p.cab_type.extra_hour_charge,
            extra_km_charge: p.cab_type.extra_km_charge,
          },
          pricing: {
            total_fair_pre_gst: effective.totalFairPreGst,
            gst_pct: effective.gstPct,
            gst_charge: effective.gstCharge,
            platform_charge: effective.techFeeAmount,
            total_payment: effective.totalPayment,
            billed_km: effective.billedKm,
            extra_km: effective.extraKm,
            extra_km_charge_pre_gst: effective.extraKmChargePreGst,
          },
          ...(availability ? { availability } : {}),
        };
      })
      // Hide cab categories that have 0 free cabs in the selected source city (e.g. all cabs on ongoing rides).
      .filter((p) => !p.availability || p.availability.is_available);

    return NextResponse.json({
      success: true,
      booking_types: BOOKING_TYPES,
      ...(originCity ? { origin_city: originCity } : {}),
      ...(destinationCity ? { destination_city: destinationCity } : {}),
      ...(routeDistance ? { route_distance: routeDistance } : {}),
      plans: publicPlans,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
