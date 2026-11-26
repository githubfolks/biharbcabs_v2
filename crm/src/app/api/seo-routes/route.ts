import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await query(`SELECT * FROM crm_seo_routes ORDER BY is_published DESC, id DESC`);
    return NextResponse.json({
      success: true,
      routes: res.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        distance_km: r.distance_km !== null ? Number(r.distance_km) : null,
      })),
    });
  } catch (err: any) {
    return handleRouteError(err, 'API seo-routes');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const slug = String(body.slug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120);
    const originCity = String(body.origin_city || '').trim().slice(0, 100);
    const destinationCity = body.destination_city ? String(body.destination_city).trim().slice(0, 100) : null;
    const bookingType = ['OUTSTATION', 'LOCAL', 'RENTAL'].includes(String(body.booking_type || '').toUpperCase())
      ? String(body.booking_type).toUpperCase()
      : 'OUTSTATION';
    const pageTitle = String(body.page_title || `${originCity} to ${destinationCity || originCity} Cab - BiharCabs`).trim().slice(0, 180);
    const metaDescription = String(
      body.meta_description || `Book verified AC cabs from ${originCity}${destinationCity ? ` to ${destinationCity}` : ''} with transparent fares and instant WhatsApp booking.`
    ).trim().slice(0, 320);
    const heroHeading = String(body.hero_heading || `${originCity}${destinationCity ? ` to ${destinationCity}` : ''} Cab Service`).trim().slice(0, 180);
    const introCopy = body.intro_copy ? String(body.intro_copy).trim().slice(0, 2000) : null;
    const distanceKm = body.distance_km ? Number(body.distance_km) : null;
    const driveTimeText = body.drive_time_text ? String(body.drive_time_text).trim().slice(0, 60) : null;
    const faqs = Array.isArray(body.faqs_json) ? body.faqs_json : [];

    if (!SLUG_RE.test(slug) || !originCity) {
      return NextResponse.json({ success: false, error: 'Valid URL slug (lowercase letters/numbers/hyphens) and origin city are required.' }, { status: 400 });
    }

    const ins = await query(
      `INSERT INTO crm_seo_routes
         (slug, origin_city, destination_city, booking_type, page_title, meta_description, hero_heading, intro_copy, distance_km, drive_time_text, faqs_json, is_published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, true)
       RETURNING *`,
      [slug, originCity, destinationCity, bookingType, pageTitle, metaDescription, heroHeading, introCopy, distanceKm, driveTimeText, JSON.stringify(faqs)]
    );
    const route = ins.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'SEO_ROUTE_CREATED',
      entityType: 'SEO_ROUTE',
      entityId: route.id,
      summary: `Published SEO route /cab/${slug}/ (${originCity} -> ${destinationCity || 'Local'})`,
      req,
    });

    return NextResponse.json({ success: true, route: { ...route, id: Number(route.id) } }, { status: 201 });
  } catch (err: any) {
    if (err?.code === '23505') {
      return NextResponse.json({ success: false, error: 'An SEO route with this slug already exists.' }, { status: 409 });
    }
    return handleRouteError(err, 'API seo-routes');
  }
}
