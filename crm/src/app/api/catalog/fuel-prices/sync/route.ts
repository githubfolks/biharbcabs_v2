import { NextRequest, NextResponse } from 'next/server';
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
    const status = err instanceof FuelSyncError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
