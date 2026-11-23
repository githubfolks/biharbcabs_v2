import { NextRequest, NextResponse } from 'next/server';
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
    const status = err instanceof LocationError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message, suggestions: [] }, { status });
  }
}
