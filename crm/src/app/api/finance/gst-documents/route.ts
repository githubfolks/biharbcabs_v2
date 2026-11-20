import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listGstDocuments } from '@/lib/gst-delivery';

export const dynamic = 'force-dynamic';

/** GST documents by booking code or document number (?q=), or, without q, those whose WhatsApp delivery failed. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const q = req.nextUrl.searchParams.get('q') || '';
    return NextResponse.json({ success: true, search: q.trim(), documents: await listGstDocuments(q) });
  } catch (err: any) {
    console.error('[GST] Listing documents failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not load documents' }, { status: 500 });
  }
}
