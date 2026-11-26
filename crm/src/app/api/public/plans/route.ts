import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import {
  CatalogError,
  calculateDistanceAdjustedPricing,
  calculateTripDays,
  listPricedPackages,
  parseOptionalCoords,
  resolveRouteDistanceSafely,
  selectBestFittingPlansPerCab,
} from '@/lib/pricing-engine';
import { BOOKING_TYPES } from '@/lib/booking-rules';
import { getCityCabAvailability } from '@/lib/availability';
import { getPackageDistanceTolerancePct, getSplitRules } from '@/lib/settings';
import { checkRouteServiceability } from '@/lib/service-area';
import {
  consumeRateLimit,
  getPublicClientIp,
  getPublicRateLimits,
  rateLimitExceededResponse,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Public read-only endpoint consumed by the WordPress frontend to display
 * configured cabs and booking plans. Never exposes internal integer IDs.
 */
export async function GET(req: NextRequest) {
  const limits = await getPublicRateLimits();
  const ip = getPublicClientIp(req);
  const ipLimit = consumeRateLimit(`pub:plans:ip:${ip}`, limits.plans_per_ip_10m);
  if (!ipLimit.allowed) {
    return rateLimitExceededResponse(ipLimit, 'Too many plan requests. Please try again shortly.');
  }

  try {
    const { searchParams } = new URL(req.url);
    const rawType = searchParams.get('booking_type');
    const originCity = searchParams.get('origin_city')?.trim() || '';
    const destinationCity = searchParams.get('destination_city')?.trim() || '';
    const pickupDate = searchParams.get('pickup_date');
    const pickupTime = searchParams.get('pickup_time');
    const isRoundTrip = searchParams.get('is_round_trip') === 'true' || searchParams.get('is_round_trip') === '1';
    const returnDate = searchParams.get('return_date')?.trim() || null;
    const tripDays = calculateTripDays(pickupDate, returnDate, isRoundTrip);
    const fromCoords = parseOptionalCoords(searchParams.get('from_lat'), searchParams.get('from_lon'));
    const toCoords = parseOptionalCoords(searchParams.get('to_lat'), searchParams.get('to_lon'));
    const bookingType = rawType ? rawType.trim().toUpperCase() : null;
    if (bookingType && !BOOKING_TYPES.includes(bookingType as any)) {
      return NextResponse.json(
        { success: false, error: `booking_type must be one of: ${BOOKING_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    const [packages, availMap, routeDistance, splitRules, tolerancePct, serviceCoverage] = await Promise.all([
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
      getPackageDistanceTolerancePct(),
      originCity || destinationCity
        ? checkRouteServiceability({ origin: originCity || null, destination: destinationCity || null })
        : Promise.resolve({ serviceable: true, code: 'OK' as const, reason: null, supportPhone: null }),
    ]);

    if (!serviceCoverage.serviceable) {
      return NextResponse.json({
        success: true,
        booking_types: BOOKING_TYPES,
        ...(originCity ? { origin_city: originCity } : {}),
        ...(destinationCity ? { destination_city: destinationCity } : {}),
        ...(routeDistance ? { route_distance: routeDistance } : {}),
        service_coverage: serviceCoverage,
        plans: [],
      });
    }

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
          splitRules,
          {
            isRoundTrip,
            tripDays,
            perDayCharge: p.cab_type.per_day_charge,
            driverTa: p.cab_type.driver_ta,
            tolerancePct,
          }
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
            per_day_charge: p.cab_type.per_day_charge,
            image_url: p.cab_type.image_url,
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
            is_round_trip: effective.isRoundTrip,
            trip_days: effective.tripDays,
            extra_day_charge_pre_gst: effective.extraDayCabChargePreGst + effective.extraDayDriverTaPreGst,
            max_allowed_km: effective.maxAllowedKm,
            within_package_range: effective.withinPackageRange,
          },
          ...(availability ? { availability } : {}),
        };
      })
      // Hide cab categories with 0 free cabs in origin city AND packages whose KM range is exceeded by the route.
      .filter((p) => (!p.availability || p.availability.is_available) && p.pricing.within_package_range);

    // When a specific route distance is known, show only the best-fitting (smallest) tier per cab
    // so short trips (e.g. 55 km) don't get cluttered with oversized 12hr / 250km / 300km plans.
    const matchedPlans =
      routeDistance && routeDistance.distance_km > 0
        ? selectBestFittingPlansPerCab(
            publicPlans,
            (p) => `${p.booking_type}:${p.cab.code}`,
            (p) => p.included_km,
            (p) => p.included_hours
          )
        : publicPlans;

    // Build deduplicated live cab catalog from active priced plans (single source of truth for WordPress fleet cards)
    const cabsByCode = new Map<string, any>();
    for (const p of matchedPlans) {
      const existing = cabsByCode.get(p.cab.code);
      if (!existing) {
        cabsByCode.set(p.cab.code, {
          ...p.cab,
          starting_fare: p.pricing.total_payment,
          starting_plan_name: p.name,
          starting_plan_public_id: p.public_id,
          starting_booking_type: p.booking_type,
          plan_count: 1,
          ...(p.availability ? { availability: p.availability } : {}),
        });
      } else {
        existing.plan_count += 1;
        if (p.pricing.total_payment < existing.starting_fare) {
          existing.starting_fare = p.pricing.total_payment;
          existing.starting_plan_name = p.name;
          existing.starting_plan_public_id = p.public_id;
          existing.starting_booking_type = p.booking_type;
        }
      }
    }

    return NextResponse.json({
      success: true,
      booking_types: BOOKING_TYPES,
      ...(originCity ? { origin_city: originCity } : {}),
      ...(destinationCity ? { destination_city: destinationCity } : {}),
      ...(routeDistance ? { route_distance: routeDistance } : {}),
      service_coverage: serviceCoverage,
      cabs: Array.from(cabsByCode.values()),
      plans: matchedPlans,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API public/plans');
  }
}
