import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { addVehicle, parseVehicleInput } from '@/lib/driver-edits';
import { badRequest, editErrorResponse, jsonBody, positiveId } from '@/lib/driver-edit-http';

export const dynamic = 'force-dynamic';

/** Add a vehicle. All three document dates are required and not past; the vehicle is verified at once. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = positiveId(params.id);
  if (!driverId) return badRequest('Invalid driver ID');
  const body = await jsonBody(req);
  if (body === undefined) return badRequest('Body must be JSON');
  const parsed = parseVehicleInput(body, 'add');
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    return NextResponse.json({ success: true, ...(await addVehicle(driverId, parsed.value, auth.id)) });
  } catch (err: any) {
    return editErrorResponse(err, 'Adding vehicle');
  }
}
