import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { autocompletePlaces, LocationError } from '@/lib/locationiq';
import {
  consumeRateLimit,
  getPublicClientIp,
  getPublicRateLimits,
  rateLimitExceededResponse,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Public server-side LocationIQ autocomplete proxy for the WordPress booking frontend.
 * Uses the CRM's configured locationiq_config (including Referer) without exposing API keys in the browser.
 */
export async function GET(req: NextRequest) {
  const limits = await getPublicRateLimits();
  const ip = getPublicClientIp(req);
  const ipLimit = consumeRateLimit(`pub:autocomplete:ip:${ip}`, limits.autocomplete_per_ip_10m);
  if (!ipLimit.allowed) {
    return rateLimitExceededResponse(ipLimit, 'Too many location search requests. Please wait a moment.', {
      suggestions: [],
    });
  }
  try {
    const q = new URL(req.url).searchParams.get('q') || '';
    if (q.trim().length < 2) {
      return NextResponse.json({ success: true, suggestions: [] });
    }
    const suggestions = await autocompletePlaces(q);
    return NextResponse.json({ success: true, suggestions });
  } catch (err: any) {
    return handleRouteError(err, 'API public/location/autocomplete', 'Location lookup failed', { suggestions: [] });
  }
}
