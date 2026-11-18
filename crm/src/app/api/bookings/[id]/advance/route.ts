import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { WaiverError, waiveBookingAdvance } from '@/lib/advance-payments';

export const dynamic = 'force-dynamic';

/**
 * Waive the customer advance on a booking waiting for it: { action: "waive", reason }.
 * The Razorpay link is cancelled first; the ride becomes full cash and goes to drivers.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'bookings.waive_advance');
  if (auth instanceof NextResponse) return auth;
  try {
    const bookingId = Number(params.id);
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid booking id' }, { status: 400 });
    }
    const body = await req.json();
    if (body?.action !== 'waive') {
      return NextResponse.json({ success: false, error: 'Unsupported action. Supported: waive' }, { status: 400 });
    }
    const result = await waiveBookingAdvance({ bookingId, adminId: auth.id, reason: String(body?.reason || '') });
    return NextResponse.json({
      success: true,
      ...result,
      message: result.dispatched
        ? `Advance waived on ${result.bookingCode}; the ride was sent to drivers.`
        : `Advance waived on ${result.bookingCode}, but sending it to drivers failed. Use Broadcast to retry.`,
    });
  } catch (err: any) {
    if (err instanceof WaiverError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
