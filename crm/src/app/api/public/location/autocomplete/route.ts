import { NextRequest, NextResponse } from 'next/server';
import { autocompletePlaces, LocationError } from '@/lib/locationiq';

export const dynamic = 'force-dynamic';

// Simple per-IP rate limiter (120 requests per 10 minutes for typing autocomplete)
const hits = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit = 120, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/**
 * Public server-side LocationIQ autocomplete proxy for the WordPress booking frontend.
 * Uses the CRM's configured locationiq_config (including Referer) without exposing API keys in the browser.
 */
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ success: false, error: 'Too many requests.', suggestions: [] }, { status: 429 });
  }
  try {
    const q = new URL(req.url).searchParams.get('q') || '';
    if (q.trim().length < 2) {
      return NextResponse.json({ success: true, suggestions: [] });
    }
    const suggestions = await autocompletePlaces(q);
    return NextResponse.json({ success: true, suggestions });
  } catch (err: any) {
    const status = err instanceof LocationError ? err.status : 500;
    return NextResponse.json({ success: false, error: err.message, suggestions: [] }, { status });
  }
}
