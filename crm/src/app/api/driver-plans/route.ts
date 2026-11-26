import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { PlanError, createSubscriptionPlan, listSubscriptionPlans } from '@/lib/driver-plans';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'plans.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const activeOnly = new URL(req.url).searchParams.get('active') === 'true';
    const plans = await listSubscriptionPlans({ activeOnly });
    return NextResponse.json({ success: true, plans });
  } catch (err: any) {
    return handleRouteError(err, 'API driver-plans');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'plans.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const plan = await createSubscriptionPlan(body);
    return NextResponse.json({ success: true, plan }, { status: 201 });
  } catch (err: any) {
    return handleRouteError(err, 'API driver-plans');
  }
}
