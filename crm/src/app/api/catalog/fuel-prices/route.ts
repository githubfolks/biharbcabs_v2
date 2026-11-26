import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, listFuelPrices, updateFuelPrice } from '@/lib/pricing-engine';
import { getFuelPriceApiConfig, getFuelPriceSyncState } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const [fuelPrices, syncState, apiCfg] = await Promise.all([
      listFuelPrices(),
      getFuelPriceSyncState(),
      getFuelPriceApiConfig(),
    ]);
    return NextResponse.json({
      success: true,
      fuelPrices,
      syncState,
      apiConfigured: Boolean(apiCfg.endpoint_url),
      autoSyncEnabled: Boolean(apiCfg.enabled && apiCfg.endpoint_url),
    });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/fuel-prices');
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
    return handleRouteError(err, 'API catalog/fuel-prices');
  }
}
