import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { CatalogError, updatePackage } from '@/lib/pricing-engine';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid package ID' }, { status: 400 });
    }
    const body = await req.json();
    const pkg = await updatePackage(id, body);
    return NextResponse.json({ success: true, package: pkg });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/packages/[id]');
  }
}
