import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  CatalogError,
  calculateDistanceAdjustedPricing,
  createPackage,
  listPricedPackages,
  parseOptionalCoords,
  resolveRouteDistanceSafely,
} from '@/lib/pricing-engine';
import { getCityCabAvailability } from '@/lib/availability';
import { getSplitRules } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get('active') === 'true';
    const bookingType = searchParams.get('booking_type');
    const originCity = searchParams.get('origin_city')?.trim() || '';
    const destinationCity = searchParams.get('destination_city')?.trim() || '';
    const pickupDate = searchParams.get('pickup_date');
    const pickupTime = searchParams.get('pickup_time');
    const fromCoords = parseOptionalCoords(searchParams.get('from_lat'), searchParams.get('from_lon'));
    const toCoords = parseOptionalCoords(searchParams.get('to_lat'), searchParams.get('to_lon'));

    const [packages, availMap, routeDistance, splitRules] = await Promise.all([
      listPricedPackages({ activeOnly, bookingType, skipUnpriceable: true }),
      originCity ? getCityCabAvailability({ originCity, pickupDate, pickupTime }) : Promise.resolve(null),
      resolveRouteDistanceSafely(
        { fromCoords, toCoords, originText: originCity, destinationText: destinationCity },
        'Catalog Packages'
      ),
      getSplitRules(),
    ]);

    const enriched = packages.map((p) => {
      const pricing = routeDistance
        ? calculateDistanceAdjustedPricing(
            p.pricing,
            p.included_km,
            p.cab_type.extra_km_charge,
            routeDistance.distance_km,
            splitRules
          )
        : p.pricing;

      if (!availMap) return { ...p, pricing };

      const cat = p.cab_type.category.toUpperCase();
      const av = availMap[cat] ?? {
        city: originCity,
        category: cat,
        total_cabs: 0,
        available_cabs: 0,
        is_available: false,
      };
      return { ...p, pricing, availability: av };
    });

    return NextResponse.json({
      success: true,
      ...(originCity ? { origin_city: originCity } : {}),
      ...(destinationCity ? { destination_city: destinationCity } : {}),
      ...(routeDistance ? { route_distance: routeDistance } : {}),
      packages: enriched,
    });
  } catch (err: any) {
    const status = err instanceof CatalogError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const pkg = await createPackage(body);
    return NextResponse.json({ success: true, package: pkg }, { status: 201 });
  } catch (err: any) {
    const status = err instanceof CatalogError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
