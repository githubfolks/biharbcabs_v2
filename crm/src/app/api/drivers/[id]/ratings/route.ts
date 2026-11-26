import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { getDriverRatingProfile, disputeRating } from '@/lib/ratings';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'ratings.view');
  if (auth instanceof NextResponse) return auth;
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
    return handleRouteError(err, 'API drivers/[id]/ratings');
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAdmin(req, 'ratings.dispute');
  if (auth instanceof NextResponse) return auth;
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

      // Recorded against the signed-in admin (validated by requireAdmin above).
      const result = await disputeRating(ratingId, auth.id, notes);
      return NextResponse.json(result);
    }

    return NextResponse.json({ success: false, error: 'Unsupported action' }, { status: 400 });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/ratings');
  }
}
