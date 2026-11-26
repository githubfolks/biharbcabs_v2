import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { autocompletePlaces, LocationError } from '@/lib/locationiq';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.create');
  if (auth instanceof NextResponse) return auth;
  try {
    const q = new URL(req.url).searchParams.get('q') || '';
    const suggestions = await autocompletePlaces(q);
    return NextResponse.json({ success: true, suggestions });
  } catch (err: any) {
    return handleRouteError(err, 'API location/autocomplete', 'Location lookup failed', { suggestions: [] });
  }
}
