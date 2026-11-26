import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { consumeRateLimit, getPublicClientIp, rateLimitExceededResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Public list of published SEO route slugs (consumed by WordPress sitemap & internal links).
 */
export async function GET(req: NextRequest) {
  const ip = getPublicClientIp(req);
  const rl = consumeRateLimit(`pub:seo:list:${ip}`, 120);
  if (!rl.allowed) return rateLimitExceededResponse(rl);

  try {
    const res = await query(
      `SELECT slug, origin_city, destination_city, booking_type, hero_heading, distance_km, drive_time_text, updated_at
       FROM crm_seo_routes
       WHERE is_published = true
       ORDER BY slug ASC`
    );
    return NextResponse.json({
      success: true,
      routes: res.rows.map((r) => ({
        ...r,
        distance_km: r.distance_km !== null ? Number(r.distance_km) : null,
      })),
    });
  } catch (err: any) {
    return handleRouteError(err, 'API public/seo-routes');
  }
}
