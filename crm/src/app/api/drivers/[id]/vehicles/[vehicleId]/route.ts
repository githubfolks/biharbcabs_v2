import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { editVehicle, parseVehicleInput, removeVehicle } from '@/lib/driver-edits';
import { badRequest, editErrorResponse, jsonBody, positiveId } from '@/lib/driver-edit-http';
import { REASON_MAX, REASON_MIN } from '@/lib/driver-status-rules';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string; vehicleId: string } };

/** Change a vehicle's category, model or document dates. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  const vehicleId = positiveId(params.vehicleId);
  if (!driverId || !vehicleId) return badRequest('Invalid driver or vehicle ID');
  const body = await jsonBody(req);
  if (body === undefined) return badRequest('Body must be JSON');
  const parsed = parseVehicleInput(body, 'edit');
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    return NextResponse.json({ success: true, ...(await editVehicle(driverId, vehicleId, parsed.value, auth.id)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Updating vehicle');
  }
}

/** Remove a vehicle (kept for ride history). Body: { reason }. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  const vehicleId = positiveId(params.vehicleId);
  if (!driverId || !vehicleId) return badRequest('Invalid driver or vehicle ID');
  const body = await jsonBody(req);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return badRequest(`reason must be ${REASON_MIN}-${REASON_MAX} characters`);
  }
  try {
    return NextResponse.json({ success: true, ...(await removeVehicle(driverId, vehicleId, reason, auth.id)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Removing vehicle');
  }
}
