import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { NotificationFailureError, resolveNotificationFailure } from '@/lib/notification-failures';

export const dynamic = 'force-dynamic';

/** Mark a failed message handled once staff have followed it up. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'notifications.resolve');
  if (auth instanceof NextResponse) return auth;
  try {
    await resolveNotificationFailure(Number(params.id), auth.id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err instanceof NotificationFailureError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error('[Notifications] Marking a failed message handled failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not mark the message handled' }, { status: 500 });
  }
}
