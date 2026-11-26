import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, createCabType, listCabTypes } from '@/lib/pricing-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const activeOnly = new URL(req.url).searchParams.get('active') === 'true';
    const cabTypes = await listCabTypes({ activeOnly });
    return NextResponse.json({ success: true, cabTypes });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/cab-types');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const cabType = await createCabType(body);
    return NextResponse.json({ success: true, cabType }, { status: 201 });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/cab-types');
  }
}
