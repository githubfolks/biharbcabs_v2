import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listDocumentsAwaitingPlaceOfSupply } from '@/lib/place-of-supply';

export const dynamic = 'force-dynamic';

/** GST documents waiting for staff to choose their place of supply (unlisted pickup city or malformed GSTIN). */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, documents: await listDocumentsAwaitingPlaceOfSupply() });
  } catch (err: any) {
    console.error('[GST] Listing documents awaiting place of supply failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not load documents' }, { status: 500 });
  }
}
