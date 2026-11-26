import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { getSetting } from '@/lib/settings';
import { consumeRateLimit, getPublicClientIp, rateLimitExceededResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

/**
 * Zero-App Public Customer Trip Status Endpoint (token-gated, non-PII).
 * Never returns customer phone, full home address, or fare. Expires 24 hours after completion.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getPublicClientIp(req);
  const rl = consumeRateLimit(`pub:trip:${ip}`, 120);
  if (!rl.allowed) return rateLimitExceededResponse(rl);

  const token = String(params.token || '').trim();
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ success: false, error: 'Invalid trip link.' }, { status: 400 });
  }

  try {
    const res = await query(
      `SELECT
         b.booking_code,
         b.trip_type,
         b.origin_city,
         b.destination_city,
         b.pickup_date,
         b.pickup_time,
         b.booking_status,
         b.driver_assigned_at,
         b.driver_arrived_at,
         b.trip_completed_at,
         b.sos_triggered_at,
         d.full_name AS driver_name,
         d.onboarding_status AS driver_status,
         d.rating AS driver_rating,
         v.model_name AS vehicle_model,
         v.registration_no AS vehicle_reg,
         (SELECT COUNT(*)::int FROM crm_driver_documents doc
          WHERE doc.driver_id = d.id AND doc.verification_status = 'VERIFIED') AS verified_docs_count
       FROM crm_bookings b
       LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
       LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
       WHERE b.tracking_token = $1
       LIMIT 1`,
      [token]
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Trip link not found.' }, { status: 404 });
    }

    const row = res.rows[0];
    if (row.trip_completed_at) {
      const completedMs = Date.parse(row.trip_completed_at);
      if (!Number.isNaN(completedMs) && Date.now() - completedMs > 24 * 60 * 60 * 1000) {
        return NextResponse.json(
          { success: false, error: 'This trip tracking link has expired (24h after completion).' },
          { status: 410 }
        );
      }
    }

    const billing = await getSetting<{ phone?: string; trade_name?: string }>('company_billing_info', {});

    return NextResponse.json({
      success: true,
      trip: {
        booking_code: row.booking_code,
        trip_type: row.trip_type,
        origin_city: row.origin_city,
        destination_city: row.destination_city,
        pickup_date: row.pickup_date,
        pickup_time: String(row.pickup_time || '').slice(0, 5),
        booking_status: row.booking_status,
        driver_assigned_at: row.driver_assigned_at,
        driver_arrived_at: row.driver_arrived_at,
        trip_completed_at: row.trip_completed_at,
        sos_triggered_at: row.sos_triggered_at,
        driver: row.driver_name
          ? {
              name: row.driver_name,
              rating: Number(row.driver_rating || 5),
              kyc_verified: row.driver_status === 'APPROVED_ACTIVE' || Number(row.verified_docs_count || 0) > 0,
              vehicle_model: row.vehicle_model || null,
              vehicle_reg: row.vehicle_reg || null,
            }
          : null,
        support_phone: billing?.phone || null,
        brand_name: billing?.trade_name || 'BiharCabs',
      },
    });
  } catch (err: any) {
    return handleRouteError(err, 'API public/trip/[token]');
  }
}
