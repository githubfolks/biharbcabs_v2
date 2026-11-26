import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { awardDriverIncentive } from '@/lib/billing';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'incentives.award');
  if (auth instanceof NextResponse) return auth;
  const admin = auth;
  try {
    const driverId = parseInt(params.id, 10);
    if (isNaN(driverId)) {
      return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
    }

    const body = await req.json();
    const { amount, reason } = body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Valid positive incentive amount is required' }, { status: 400 });
    }

    const result = await awardDriverIncentive(
      driverId,
      amount,
      reason || `Admin Incentive Awarded by ${admin.full_name || 'Ops Manager'}`
    );

    return NextResponse.json({
      driverId,
      ...result,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/incentives');
  }
}
