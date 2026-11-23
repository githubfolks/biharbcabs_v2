import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, createPackage, listPricedPackages } from '@/lib/pricing-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get('active') === 'true';
    const bookingType = searchParams.get('booking_type');
    const packages = await listPricedPackages({ activeOnly, bookingType, skipUnpriceable: true });
    return NextResponse.json({ success: true, packages });
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
