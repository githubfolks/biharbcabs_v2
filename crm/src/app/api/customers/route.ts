import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_TAGS = ['REGULAR', 'VIP', 'BLOCKED'] as const;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'customers.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q')?.trim() || '';
    const tag = searchParams.get('tag')?.trim().toUpperCase() || '';
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100));

    const where: string[] = [];
    const params: unknown[] = [];

    if (tag && (VALID_TAGS as readonly string[]).includes(tag)) {
      params.push(tag);
      where.push(`c.tag = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(COALESCE(c.full_name, '') ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR COALESCE(c.email, '') ILIKE $${params.length} OR COALESCE(c.company_name, '') ILIKE $${params.length} OR COALESCE(c.gstin, '') ILIKE $${params.length})`
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);

    const [rowsRes, kpiRes] = await Promise.all([
      query(
        `SELECT
           c.id,
           c.phone,
           c.full_name,
           c.email,
           c.gstin,
           c.company_name,
           c.tag,
           c.notes,
           c.blocked_reason,
           c.created_at,
           COUNT(b.id)::int AS total_bookings,
           COUNT(b.id) FILTER (WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED'))::int AS completed_bookings,
           COUNT(b.id) FILTER (WHERE b.booking_status = 'CANCELLED')::int AS cancelled_bookings,
           COALESCE(SUM(b.customer_total_fare) FILTER (WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS lifetime_value,
           MAX(b.created_at) AS last_booking_at
         FROM crm_customers c
         LEFT JOIN crm_bookings b ON b.customer_id = c.id
         ${whereSql}
         GROUP BY c.id
         ORDER BY MAX(b.created_at) DESC NULLS LAST, c.id DESC
         LIMIT $${params.length}`,
        params
      ),
      query(
        `WITH per_cust AS (
           SELECT
             c.id,
             c.tag,
             COUNT(b.id) AS total_b,
             COALESCE(SUM(b.customer_total_fare) FILTER (WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')), 0) AS ltv
           FROM crm_customers c
           LEFT JOIN crm_bookings b ON b.customer_id = c.id
           GROUP BY c.id
         )
         SELECT
           COUNT(*)::int AS total_customers,
           COUNT(*) FILTER (WHERE total_b >= 2)::int AS repeat_customers,
           COUNT(*) FILTER (WHERE tag = 'VIP')::int AS vip_customers,
           COUNT(*) FILTER (WHERE tag = 'BLOCKED')::int AS blocked_customers,
           COALESCE(SUM(ltv), 0) AS total_ltv
         FROM per_cust`
      ),
    ]);

    return NextResponse.json({
      success: true,
      customers: rowsRes.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        lifetime_value: Math.round(Number(r.lifetime_value || 0) * 100) / 100,
      })),
      summary: {
        total_customers: Number(kpiRes.rows[0]?.total_customers || 0),
        repeat_customers: Number(kpiRes.rows[0]?.repeat_customers || 0),
        vip_customers: Number(kpiRes.rows[0]?.vip_customers || 0),
        blocked_customers: Number(kpiRes.rows[0]?.blocked_customers || 0),
        total_ltv: Math.round(Number(kpiRes.rows[0]?.total_ltv || 0) * 100) / 100,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
