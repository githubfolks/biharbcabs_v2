import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { resolveDrivingDistance, LocationError } from '@/lib/locationiq';
import {
  CatalogError,
  calculateDistanceAdjustedPricing,
  calculateTripDays,
  getPricedPackageById,
} from '@/lib/pricing-engine';
import { getPackageDistanceTolerancePct, getSplitRules } from '@/lib/settings';
import { checkRouteServiceability } from '@/lib/service-area';

export const dynamic = 'force-dynamic';

function parseCoord(val: string | null): number | null {
  if (val === null || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.create');
  if (auth instanceof NextResponse) return auth;
  try {
    const sp = new URL(req.url).searchParams;
    const fromLat = parseCoord(sp.get('from_lat'));
    const fromLon = parseCoord(sp.get('from_lon'));
    const toLat = parseCoord(sp.get('to_lat'));
    const toLon = parseCoord(sp.get('to_lon'));
    const origin = sp.get('origin')?.trim() || null;
    const destination = sp.get('destination')?.trim() || null;
    const packageIdRaw = sp.get('package_id')?.trim() || null;
    const isRoundTrip = sp.get('is_round_trip') === 'true' || sp.get('is_round_trip') === '1';
    const pickupDate = sp.get('pickup_date')?.trim() || null;
    const returnDate = sp.get('return_date')?.trim() || null;

    const fromCoords = fromLat !== null && fromLon !== null ? { lat: fromLat, lon: fromLon } : null;
    const toCoords = toLat !== null && toLon !== null ? { lat: toLat, lon: toLon } : null;

    const route = await resolveDrivingDistance({
      fromCoords,
      toCoords,
      originText: origin,
      destinationText: destination,
    });

    let adjusted_pricing = null;
    if (packageIdRaw) {
      const pkgId = Number(packageIdRaw);
      if (Number.isInteger(pkgId) && pkgId > 0) {
        const pkg = await getPricedPackageById(pkgId);
        if (pkg) {
          const tripDays = calculateTripDays(pickupDate, returnDate, isRoundTrip);
          const [splitRules, tolerancePct] = await Promise.all([getSplitRules(), getPackageDistanceTolerancePct()]);
          adjusted_pricing = calculateDistanceAdjustedPricing(
            pkg.pricing,
            pkg.included_km,
            pkg.cab_type.extra_km_charge,
            route.distance_km,
            splitRules,
            {
              isRoundTrip,
              tripDays,
              perDayCharge: pkg.cab_type.per_day_charge,
              driverTa: pkg.cab_type.driver_ta,
              tolerancePct,
            }
          );
        }
      }
    }

    const service_coverage = await checkRouteServiceability({
      origin,
      destination,
    });

    return NextResponse.json({ success: true, route, adjusted_pricing, service_coverage });
  } catch (err: any) {
    return handleRouteError(err, 'API location/distance');
  }
}
