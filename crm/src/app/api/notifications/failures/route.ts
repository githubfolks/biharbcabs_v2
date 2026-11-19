import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listOpenNotificationFailures } from '@/lib/notification-failures';

export const dynamic = 'force-dynamic';

/** WhatsApp messages that did not go out and have not been followed up yet. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.view');
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, ...(await listOpenNotificationFailures()) });
  } catch (err: any) {
    console.error('[Notifications] Listing failed messages failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not load failed messages' }, { status: 500 });
  }
}
