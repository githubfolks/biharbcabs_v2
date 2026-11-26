import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { PlanError, updateSubscriptionPlan } from '@/lib/driver-plans';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'plans.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid plan ID' }, { status: 400 });
    }
    const body = await req.json();
    const plan = await updateSubscriptionPlan(id, body);
    return NextResponse.json({ success: true, plan });
  } catch (err: any) {
    return handleRouteError(err, 'API driver-plans/[id]');
  }
}
