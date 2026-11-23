import { NextRequest, NextResponse } from 'next/server';
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
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
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
    const status = err instanceof PlanError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
