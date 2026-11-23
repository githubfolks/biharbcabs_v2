import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, listFuelPrices, updateFuelPrice } from '@/lib/pricing-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const fuelPrices = await listFuelPrices();
    return NextResponse.json({ success: true, fuelPrices });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const { fuel_type, price_per_unit, unit } = body;
    const updated = await updateFuelPrice(fuel_type, Number(price_per_unit), auth.id, unit);
    const fuelPrices = await listFuelPrices();
    return NextResponse.json({ success: true, updated, fuelPrices });
  } catch (err: any) {
    const status = err instanceof CatalogError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
