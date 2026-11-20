import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { changeDriverStatus, DriverStatusError, getDriverStatusDetail, parseStatusChange } from '@/lib/driver-status';

export const dynamic = 'force-dynamic';

function driverIdFrom(params: { id: string }): number | null {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function errorResponse(err: any, what: string) {
  if (err instanceof DriverStatusError) {
    return NextResponse.json({ success: false, error: err.message }, { status: err.status });
  }
  console.error(`[Driver Status] ${what} failed:`, err?.message);
  return NextResponse.json({ success: false, error: `${what} failed` }, { status: 500 });
}

/** Current status, document dates and status history. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;
  const driverId = driverIdFrom(params);
  if (!driverId) return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
  try {
    return NextResponse.json({ success: true, ...(await getDriverStatusDetail(driverId)) });
  } catch (err: any) {
    return errorResponse(err, 'Loading driver status');
  }
}

/** Activate, suspend or offboard a driver, with a reason. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  const driverId = driverIdFrom(params);
  if (!driverId) return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const parsed = parseStatusChange(body);
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });

  try {
    const result = await changeDriverStatus(driverId, parsed.change, auth.id);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return errorResponse(err, 'Changing driver status');
  }
}
