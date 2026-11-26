import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { FuelSyncError, syncFuelPricesFromApi } from '@/lib/fuel-price-sync';
import { listFuelPrices } from '@/lib/pricing-engine';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const force = body?.force !== false;
    const result = await syncFuelPricesFromApi({ force, adminId: auth.id });
    const fuelPrices = await listFuelPrices();
    return NextResponse.json({
      success: true,
      ...result,
      fuelPrices,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/fuel-prices/sync');
  }
}
