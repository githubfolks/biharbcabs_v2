import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import { upsertSupportTicket } from '@/lib/support-tickets';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'bookings.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const status = req.nextUrl.searchParams.get('status')?.trim().toUpperCase() || '';
    const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '50', 10) || 50));

    const params: unknown[] = [];
    let whereSql = '';
    if (status && ['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(status)) {
      params.push(status);
      whereSql = `WHERE t.status = $1`;
    }
    params.push(limit);

    const [rowsRes, countRes] = await Promise.all([
      query(
        `SELECT
           t.*,
           b.booking_code,
           b.origin_city,
           b.destination_city,
           c.full_name AS customer_name,
           c.phone AS customer_phone,
           d.full_name AS driver_name,
           d.phone AS driver_phone,
           res_admin.full_name AS resolved_by_name
         FROM crm_support_tickets t
         LEFT JOIN crm_bookings b ON b.id = t.booking_id
         LEFT JOIN crm_customers c ON c.id = t.customer_id
         LEFT JOIN crm_drivers d ON d.id = t.driver_id
         LEFT JOIN crm_admin_users res_admin ON res_admin.id = t.resolved_by
         ${whereSql}
         ORDER BY
           CASE t.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
           CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,
           t.created_at DESC
         LIMIT $${params.length}`,
        params
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open_count,
           COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress_count,
           COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved_count
         FROM crm_support_tickets`
      ),
    ]);

    return NextResponse.json({
      success: true,
      tickets: rowsRes.rows.map((r) => ({ ...r, id: Number(r.id) })),
      summary: countRes.rows[0] || { open_count: 0, in_progress_count: 0, resolved_count: 0 },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'dispatch.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const summary = String(body.summary || '').trim().slice(0, 1000);
    if (!summary) {
      return NextResponse.json({ success: false, error: 'Ticket summary is required.' }, { status: 400 });
    }
    const result = await upsertSupportTicket({
      bookingId: body.booking_id ? Number(body.booking_id) : null,
      customerId: body.customer_id ? Number(body.customer_id) : null,
      driverId: body.driver_id ? Number(body.driver_id) : null,
      source: 'MANUAL',
      priority: ['NORMAL', 'HIGH', 'CRITICAL'].includes(String(body.priority || '').toUpperCase())
        ? (String(body.priority).toUpperCase() as any)
        : 'NORMAL',
      category: body.category ? String(body.category).trim().slice(0, 60) : null,
      summary,
      alertAdmins: false,
    });

    await recordAuditLog({
      actor: auth,
      action: 'SUPPORT_TICKET_CREATED',
      entityType: 'SUPPORT_TICKET',
      entityId: result.id,
      summary: `Created support ticket #${result.id}: ${summary.slice(0, 120)}`,
      req,
    });

    return NextResponse.json({ success: true, id: result.id }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
