import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { PlaceOfSupplyError, setInvoicePlaceOfSupply } from '@/lib/place-of-supply';

export const dynamic = 'force-dynamic';

/** Choose a waiting invoice's place of supply: { stateCode: "10", rememberCity?: boolean }. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'invoices.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const result = await setInvoicePlaceOfSupply({
      invoiceId: Number(params.id),
      stateCode: String(body?.stateCode ?? ''),
      rememberCity: body?.rememberCity === true,
      adminId: auth.id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    if (err instanceof PlaceOfSupplyError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error('[Invoices] Setting place of supply failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not set the place of supply' }, { status: 500 });
  }
}
