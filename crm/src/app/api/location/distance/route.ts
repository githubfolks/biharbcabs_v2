import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { calculateDrivingDistance, LocationError } from '@/lib/locationiq';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.create');
  if (auth instanceof NextResponse) return auth;
  try {
    const sp = new URL(req.url).searchParams;
    const fromLat = Number(sp.get('from_lat'));
    const fromLon = Number(sp.get('from_lon'));
    const toLat = Number(sp.get('to_lat'));
    const toLon = Number(sp.get('to_lon'));

    const route = await calculateDrivingDistance(
      { lat: fromLat, lon: fromLon },
      { lat: toLat, lon: toLon }
    );
    return NextResponse.json({ success: true, route });
  } catch (err: any) {
    const status = err instanceof LocationError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
}
