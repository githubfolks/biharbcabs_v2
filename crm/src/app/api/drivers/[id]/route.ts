import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDriverEditDetail, parseDriverDetails, updateDriverDetails } from '@/lib/driver-edits';
import { badRequest, editErrorResponse, jsonBody, positiveId } from '@/lib/driver-edit-http';

export const dynamic = 'force-dynamic';

/** Driver details, current vehicles and recent edits. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  try {
    return NextResponse.json({ success: true, ...(await getDriverEditDetail(driverId)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Loading driver');
  }
}

/** Change name, phones, city, licence number or licence expiry. Payout details have their own route. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  const body = await jsonBody(req);
  if (body === undefined) return badRequest('Body must be JSON');
  const parsed = parseDriverDetails(body);
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    return NextResponse.json({ success: true, ...(await updateDriverDetails(driverId, parsed.value, auth.id)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Updating driver');
  }
}
