import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { parsePayoutDetails, updatePayoutDetails } from '@/lib/driver-edits';
import { badRequest, editErrorResponse, jsonBody, positiveId } from '@/lib/driver-edit-http';

export const dynamic = 'force-dynamic';

/** Change where payouts go: UPI ID, bank account number, IFSC. Super admin and finance only. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.payout_details');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  const body = await jsonBody(req);
  if (body === undefined) return badRequest('Body must be JSON');
  const parsed = parsePayoutDetails(body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    return NextResponse.json({ success: true, ...(await updatePayoutDetails(driverId, parsed.value, auth.id)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Updating payout details');
  }
}
