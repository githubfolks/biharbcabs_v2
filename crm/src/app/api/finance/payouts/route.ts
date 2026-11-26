import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { PayoutError, listDriversOwed, recordDriverPayout } from '@/lib/payouts';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/** Drivers BiharCabs owes money to. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, drivers: await listDriversOwed() });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** Record money paid to a driver: { driverId, amount, channel, reference, notes? } */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'payouts.record');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const driverId = Number(body?.driverId);
    if (!Number.isInteger(driverId) || driverId <= 0) {
      return NextResponse.json({ success: false, error: 'driverId is required' }, { status: 400 });
    }
    const result = await recordDriverPayout({
      driverId,
      amount: Number(body?.amount),
      channel: String(body?.channel || ''),
      reference: String(body?.reference || ''),
      notes: body?.notes,
      adminId: auth.id,
    });
    await recordAuditLog({
      actor: auth,
      action: 'PAYOUT_RECORDED',
      entityType: 'FINANCE',
      entityId: driverId,
      summary: `Recorded payout of ₹${Number(body?.amount)} to Driver #${driverId} via ${String(body?.channel || 'N/A')}`,
      afterData: { driverId, amount: Number(body?.amount), channel: body?.channel, reference: body?.reference },
      req,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    if (err instanceof PayoutError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
