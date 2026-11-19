import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listInvoicesAwaitingPlaceOfSupply } from '@/lib/place-of-supply';

export const dynamic = 'force-dynamic';

/** Ride invoices waiting for staff to choose their place of supply (unlisted pickup city or malformed GSTIN). */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, invoices: await listInvoicesAwaitingPlaceOfSupply() });
  } catch (err: any) {
    console.error('[Invoices] Listing invoices awaiting place of supply failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not load invoices' }, { status: 500 });
  }
}
