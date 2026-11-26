import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { getDriverPlanSummary } from '@/lib/driver-plans';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const driverId = parseInt(params.id, 10);
    if (!Number.isInteger(driverId) || driverId <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
    }
    const summary = await getDriverPlanSummary(driverId);
    return NextResponse.json({ success: true, ...summary });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/plan');
  }
}
