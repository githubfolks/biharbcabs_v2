import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { PlaceOfSupplyError, setDocumentPlaceOfSupply } from '@/lib/place-of-supply';

export const dynamic = 'force-dynamic';

/** Choose a waiting document's place of supply (kind TI, RV or CC): { stateCode: "10", rememberCity?: boolean }. */
export async function POST(req: NextRequest, { params }: { params: { kind: string; id: string } }) {
  const auth = await requireAdmin(req, 'gst_documents.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const result = await setDocumentPlaceOfSupply({
      kind: String(params.kind || '').toUpperCase(),
      id: Number(params.id),
      stateCode: String(body?.stateCode ?? ''),
      rememberCity: body?.rememberCity === true,
      adminId: auth.id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    if (err instanceof PlaceOfSupplyError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error('[GST] Setting place of supply failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not set the place of supply' }, { status: 500 });
  }
}
