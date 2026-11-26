import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const VALID_TAGS = ['REGULAR', 'VIP', 'BLOCKED'] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'customers.view');
  if (auth instanceof NextResponse) return auth;

  const customerId = Number(params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid customer ID' }, { status: 400 });
  }

  try {
    const [custRes, bookingsRes] = await Promise.all([
      query(
        `SELECT id, phone, full_name, email, gstin, company_name, tag, notes, blocked_reason, created_at, updated_at
         FROM crm_customers WHERE id = $1 LIMIT 1`,
        [customerId]
      ),
      query(
        `SELECT
           b.id, b.booking_code, b.trip_type, b.origin_city, b.destination_city,
           b.pickup_date, b.pickup_time, b.wp_vehicle_code, b.customer_total_fare,
           b.booking_status, b.payment_status, b.created_at,
           d.full_name AS driver_name, d.phone AS driver_phone
         FROM crm_bookings b
         LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
         WHERE b.customer_id = $1
         ORDER BY b.created_at DESC
         LIMIT 30`,
        [customerId]
      ),
    ]);

    if (custRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      customer: { ...custRes.rows[0], id: Number(custRes.rows[0].id) },
      bookings: bookingsRes.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'customers.manage');
  if (auth instanceof NextResponse) return auth;

  const customerId = Number(params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid customer ID' }, { status: 400 });
  }

  try {
    const existingRes = await query(
      `SELECT id, phone, full_name, email, gstin, company_name, tag, notes, blocked_reason
       FROM crm_customers WHERE id = $1 LIMIT 1`,
      [customerId]
    );
    if (existingRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
    }
    const before = existingRes.rows[0];
    const body = await req.json();

    const nextFullName =
      body.full_name !== undefined ? String(body.full_name || '').trim().slice(0, 150) || null : before.full_name;
    const nextEmail =
      body.email !== undefined ? String(body.email || '').trim().slice(0, 150) || null : before.email;
    const nextGstin =
      body.gstin !== undefined ? String(body.gstin || '').trim().toUpperCase().slice(0, 20) || null : before.gstin;
    const nextCompany =
      body.company_name !== undefined ? String(body.company_name || '').trim().slice(0, 150) || null : before.company_name;
    const nextTag = body.tag !== undefined ? String(body.tag).trim().toUpperCase() : before.tag;
    const nextNotes = body.notes !== undefined ? String(body.notes || '').trim().slice(0, 2000) || null : before.notes;
    const nextBlockedReason =
      nextTag === 'BLOCKED'
        ? (body.blocked_reason !== undefined ? String(body.blocked_reason || '').trim().slice(0, 500) : before.blocked_reason) || 'Blocked by operations'
        : null;

    if (!(VALID_TAGS as readonly string[]).includes(nextTag)) {
      return NextResponse.json({ success: false, error: `Invalid tag. Must be one of: ${VALID_TAGS.join(', ')}` }, { status: 400 });
    }

    const upd = await query(
      `UPDATE crm_customers
       SET full_name = $1, email = $2, gstin = $3, company_name = $4,
           tag = $5, notes = $6, blocked_reason = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING id, phone, full_name, email, gstin, company_name, tag, notes, blocked_reason, updated_at`,
      [nextFullName, nextEmail, nextGstin, nextCompany, nextTag, nextNotes, nextBlockedReason, customerId]
    );
    const updated = upd.rows[0];

    await recordAuditLog({
      actor: auth,
      action: nextTag === 'BLOCKED' && before.tag !== 'BLOCKED' ? 'CUSTOMER_BLOCKED' : 'CUSTOMER_UPDATED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      summary: `Updated customer ${before.phone} (${nextFullName || 'Unnamed'}) — tag: ${nextTag}`,
      beforeData: { full_name: before.full_name, tag: before.tag, gstin: before.gstin, company_name: before.company_name },
      afterData: { full_name: updated.full_name, tag: updated.tag, gstin: updated.gstin, company_name: updated.company_name, blocked_reason: updated.blocked_reason },
      req,
    });

    return NextResponse.json({ success: true, customer: { ...updated, id: Number(updated.id) } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
