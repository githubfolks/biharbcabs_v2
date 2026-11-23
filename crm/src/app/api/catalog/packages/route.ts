import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, createPackage, listPricedPackages } from '@/lib/pricing-engine';
import { getCityCabAvailability } from '@/lib/availability';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get('active') === 'true';
    const bookingType = searchParams.get('booking_type');
    const originCity = searchParams.get('origin_city')?.trim() || '';
    const pickupDate = searchParams.get('pickup_date');
    const pickupTime = searchParams.get('pickup_time');

    const packages = await listPricedPackages({ activeOnly, bookingType, skipUnpriceable: true });

    if (!originCity) {
      return NextResponse.json({ success: true, packages });
    }

    const availMap = await getCityCabAvailability({ originCity, pickupDate, pickupTime });
    const enriched = packages.map((p) => {
      const cat = p.cab_type.category.toUpperCase();
      const av = availMap[cat] ?? {
        city: originCity,
        category: cat,
        total_cabs: 0,
        available_cabs: 0,
        is_available: false,
      };
      return { ...p, availability: av };
    });

    return NextResponse.json({ success: true, origin_city: originCity, packages: enriched });
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
