import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { setOffersPaused } from '@/lib/driver-edits';
import { notifyDriver } from '@/lib/driver-notices';
import { badRequest, editErrorResponse, jsonBody, positiveId } from '@/lib/driver-edit-http';
import { REASON_MAX, REASON_MIN } from '@/lib/driver-status-rules';

export const dynamic = 'force-dynamic';

/** Pause or resume a driver's ride offers. Body: { paused: boolean, reason }. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  const body = await jsonBody(req);
  if (body === undefined) return badRequest('Body must be JSON');
  if (typeof body.paused !== 'boolean') return badRequest('paused must be true or false');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return badRequest(`reason must be ${REASON_MIN}-${REASON_MAX} characters`);
  }
  try {
    const result = await setOffersPaused(driverId, body.paused, reason, auth.id);
    // The change is saved; the message to the driver follows and cannot undo it.
    const notice = await notifyDriver(driverId, body.paused ? 'OFFERS_PAUSED' : 'OFFERS_RESUMED');
    return NextResponse.json({ success: true, ...result, notice });
  } catch (err: any) {
    return editErrorResponse(err, 'Changing ride offers');
  }
}
