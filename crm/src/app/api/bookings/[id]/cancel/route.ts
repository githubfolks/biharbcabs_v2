import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { CancelError, cancelBooking, previewCancellation } from '@/lib/cancellations';

export const dynamic = 'force-dynamic';

const badId = () => NextResponse.json({ success: false, error: 'Invalid booking id' }, { status: 400 });
const failure = (err: any) =>
  err instanceof CancelError
    ? NextResponse.json({ success: false, error: err.message }, { status: err.status })
    : NextResponse.json({ success: false, error: err.message }, { status: 500 });

/** What cancelling now would refund, for ?fault=CUSTOMER|BIHARCABS. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'bookings.cancel');
  if (auth instanceof NextResponse) return auth;
  try {
    const bookingId = Number(params.id);
    if (!Number.isInteger(bookingId) || bookingId <= 0) return badId();
    const fault = new URL(req.url).searchParams.get('fault') === 'BIHARCABS' ? 'BIHARCABS' : 'CUSTOMER';
    return NextResponse.json({ success: true, ...(await previewCancellation(bookingId, fault)) });
  } catch (err: any) {
    return failure(err);
  }
}

/**
 * Cancel a booking: { fault: CUSTOMER | BIHARCABS, reason }.
 * CUSTOMER: the customer asked (2-hour refund rule). BIHARCABS: no driver, driver no-show, operational (full refund).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'bookings.cancel');
  if (auth instanceof NextResponse) return auth;
  try {
    const bookingId = Number(params.id);
    if (!Number.isInteger(bookingId) || bookingId <= 0) return badId();
    const body = await req.json();
    const result = await cancelBooking({ bookingId, by: 'STAFF', fault: body?.fault, reason: String(body?.reason || ''), adminId: auth.id });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return failure(err);
  }
}
