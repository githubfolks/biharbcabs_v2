import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import {
  calculateDistanceAdjustedPricing,
  listPricedPackages,
  selectBestFittingPlansPerCab,
} from '@/lib/pricing-engine';
import { getPackageDistanceTolerancePct, getSplitRules } from '@/lib/settings';
import { consumeRateLimit, getPublicClientIp, rateLimitExceededResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Public SEO route detail + live best-fit CRM cab fares (consumed by WordPress /cab/<slug>/).
 */
export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const ip = getPublicClientIp(req);
  const rl = consumeRateLimit(`pub:seo:detail:${ip}`, 120);
  if (!rl.allowed) return rateLimitExceededResponse(rl);

  const slug = String(params.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ success: false, error: 'Invalid route slug.' }, { status: 400 });
  }

  try {
    const res = await query(
      `SELECT slug, origin_city, destination_city, booking_type, page_title, meta_description,
              hero_heading, intro_copy, distance_km, drive_time_text, faqs_json, updated_at
       FROM crm_seo_routes
       WHERE slug = $1 AND is_published = true
       LIMIT 1`,
      [slug]
    );
    if (res.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Route page not found.' }, { status: 404 });
    }
    const route = res.rows[0];
    const distKm = route.distance_km !== null ? Number(route.distance_km) : null;

    const [packages, splitRules, tolerancePct] = await Promise.all([
      listPricedPackages({ activeOnly: true, bookingType: route.booking_type, skipUnpriceable: true }),
      getSplitRules(),
      getPackageDistanceTolerancePct(),
    ]);

    const scored = packages
      .map((p) => ({
        pkg: p,
        adjusted: calculateDistanceAdjustedPricing(
          p.pricing,
          p.included_km,
          p.cab_type.extra_km_charge,
          distKm,
          splitRules,
          { tolerancePct }
        ),
      }))
      .filter((e) => e.adjusted.withinPackageRange);

    const bestFit =
      distKm && distKm > 0
        ? selectBestFittingPlansPerCab(
            scored,
            (e) => `${e.pkg.booking_type}:${e.pkg.cab_type.code}`,
            (e) => e.pkg.included_km,
            (e) => e.pkg.included_hours
          )
        : scored.slice(0, 6);

    const plans = bestFit.map(({ pkg, adjusted }) => ({
      public_id: pkg.public_id,
      name: pkg.name,
      booking_type: pkg.booking_type,
      included_km: pkg.included_km,
      included_hours: pkg.included_hours,
      cab_name: pkg.cab_type.display_name,
      cab_category: pkg.cab_type.category,
      image_url: pkg.cab_type.image_url || null,
      total_payment: adjusted.totalPayment,
      extra_km_charge: pkg.cab_type.extra_km_charge,
    }));

    return NextResponse.json({
      success: true,
      route: { ...route, distance_km: distKm },
      plans,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API public/seo-routes/[slug]');
  }
}
