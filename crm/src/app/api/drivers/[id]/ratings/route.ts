import { NextRequest, NextResponse } from 'next/server';
import { getDriverRatingProfile, disputeRating } from '@/lib/ratings';
import { validateSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const driverId = parseInt(params.id, 10);
    if (isNaN(driverId)) {
      return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
    }

    const profile = await getDriverRatingProfile(driverId);
    if (!profile) {
      return NextResponse.json({ success: false, error: 'Driver not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, profile });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const driverId = parseInt(params.id, 10);
    if (isNaN(driverId)) {
      return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
    }

    const body = await req.json();
    const { action, ratingId, notes } = body;

    if (action === 'dispute') {
      if (!ratingId || !notes) {
        return NextResponse.json(
          { success: false, error: 'ratingId and dispute notes are required' },
          { status: 400 }
        );
      }

      // Extract admin user from session cookie if available
      const token = req.cookies.get('biharcabs_crm_session')?.value;
      let adminId = 1;
      if (token) {
        const session = await validateSession(token);
        if (session) adminId = session.id;
      }

      const result = await disputeRating(ratingId, adminId, notes);
      return NextResponse.json(result);
    }

    return NextResponse.json({ success: false, error: 'Unsupported action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
