import { NextRequest, NextResponse } from 'next/server';
import { awardDriverIncentive } from '@/lib/billing';
import { getCurrentAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const admin = await getCurrentAdmin();

    if (!admin) {
      return NextResponse.json({ success: false, error: 'Unauthorized admin access' }, { status: 401 });
    }

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
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
