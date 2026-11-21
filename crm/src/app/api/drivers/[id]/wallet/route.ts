import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { DriverWalletError, getDriverWallet } from '@/lib/driver-wallet';
import { badRequest, positiveId } from '@/lib/driver-edit-http';

export const dynamic = 'force-dynamic';

/** A driver's wallet and reserve balances with their latest 100 ledger entries. Money roles only. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  try {
    return NextResponse.json({ success: true, ...(await getDriverWallet(driverId)) });
  } catch (err: any) {
    if (err instanceof DriverWalletError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error('[Driver Wallet] Loading wallet failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Loading wallet failed' }, { status: 500 });
  }
}
