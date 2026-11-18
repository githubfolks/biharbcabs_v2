import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { RefundError, listOpenRefunds, requestRefund } from '@/lib/refunds';

export const dynamic = 'force-dynamic';

/** Refunds not yet processed: pending with Razorpay, failed, or stuck mid-request. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, refunds: await listOpenRefunds() });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** Retry a failed refund: { refundId }. Only FAILED refunds are resent; others report their status. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'refunds.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const refundId = Number((await req.json())?.refundId);
    if (!Number.isInteger(refundId) || refundId <= 0) {
      return NextResponse.json({ success: false, error: 'refundId is required' }, { status: 400 });
    }
    const status = await requestRefund(refundId);
    console.info(`[Refund] Retry of refund #${refundId} by admin #${auth.id}: ${status}`);
    return NextResponse.json({ success: true, status });
  } catch (err: any) {
    if (err instanceof RefundError) return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
