import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getSystemStatus } from '@/lib/system-status';

export const dynamic = 'force-dynamic';

/** Database and WhatsApp status for the CRM's status pills. Any signed-in staff; never returns credentials. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'settings.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, status: await getSystemStatus() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Status] Status check failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Status unavailable' }, { status: 500 });
  }
}
