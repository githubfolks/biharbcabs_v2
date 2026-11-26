import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'corporate.view');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid corporate account ID' }, { status: 400 });
  }

  try {
    const [accRes, membersRes, bookingsRes] = await Promise.all([
      query(`SELECT * FROM crm_corporate_accounts WHERE id = $1 LIMIT 1`, [id]),
      query(
        `SELECT * FROM crm_corporate_members WHERE corporate_account_id = $1 ORDER BY id DESC`,
        [id]
      ),
      query(
        `SELECT id, booking_code, trip_type, origin_city, destination_city, pickup_date, customer_total_fare, booking_status
         FROM crm_bookings WHERE corporate_account_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [id]
      ),
    ]);

    if (accRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Corporate account not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      account: { ...accRes.rows[0], id: Number(accRes.rows[0].id) },
      members: membersRes.rows.map((m) => ({ ...m, id: Number(m.id) })),
      bookings: bookingsRes.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'corporate.manage');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid corporate account ID' }, { status: 400 });
  }

  try {
    const existing = await query(`SELECT * FROM crm_corporate_accounts WHERE id = $1 LIMIT 1`, [id]);
    if (existing.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Corporate account not found' }, { status: 404 });
    }
    const acc = existing.rows[0];
    const body = await req.json();

    // Action 1: Add whitelisted employee phone
    if (body.add_member) {
      const empName = String(body.add_member.employee_name || '').trim().slice(0, 120);
      const empPhone = String(body.add_member.phone || '').replace(/\D/g, '').slice(0, 20);
      const dept = body.add_member.department ? String(body.add_member.department).trim().slice(0, 80) : null;
      if (!empName || empPhone.length < 10) {
        return NextResponse.json({ success: false, error: 'Employee name and 10+ digit phone required.' }, { status: 400 });
      }
      const ins = await query(
        `INSERT INTO crm_corporate_members (corporate_account_id, employee_name, phone, department)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (corporate_account_id, phone) DO UPDATE SET employee_name = EXCLUDED.employee_name, is_active = true
         RETURNING *`,
        [id, empName, empPhone, dept]
      );
      return NextResponse.json({ success: true, member: ins.rows[0] });
    }

    // Action 2: Remove employee
    if (body.remove_member_id) {
      await query(`DELETE FROM crm_corporate_members WHERE id = $1 AND corporate_account_id = $2`, [
        Number(body.remove_member_id),
        id,
      ]);
      return NextResponse.json({ success: true });
    }

    // Action 3: Record corporate bill payment (reduces current_outstanding)
    if (body.record_payment) {
      const amount = Number(body.record_payment.amount);
      const ref = String(body.record_payment.reference || '').trim().slice(0, 100);
      if (!Number.isFinite(amount) || amount <= 0 || ref.length < 4) {
        return NextResponse.json({ success: false, error: 'Positive payment amount and UTR/reference required.' }, { status: 400 });
      }
      const upd = await query(
        `UPDATE crm_corporate_accounts
         SET current_outstanding = GREATEST(0, current_outstanding - $1), updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [amount, id]
      );
      await recordAuditLog({
        actor: auth,
        action: 'CORPORATE_PAYMENT_RECORDED',
        entityType: 'CORPORATE',
        entityId: id,
        summary: `Recorded ₹${amount} B2B invoice payment for '${acc.company_name}' (Ref: ${ref})`,
        afterData: { amount, reference: ref, new_outstanding: Number(upd.rows[0].current_outstanding) },
        req,
      });
      return NextResponse.json({ success: true, account: upd.rows[0] });
    }

    // Action 4: Update account credit limit / discount / active flag
    const nextLimit = body.credit_limit !== undefined ? Math.max(0, Number(body.credit_limit)) : Number(acc.credit_limit);
    const nextDiscount = body.discount_pct !== undefined ? Math.min(50, Math.max(0, Number(body.discount_pct))) : Number(acc.discount_pct);
    const nextActive = body.is_active !== undefined ? Boolean(body.is_active) : acc.is_active;

    const upd = await query(
      `UPDATE crm_corporate_accounts
       SET credit_limit = $1, discount_pct = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [nextLimit, nextDiscount, nextActive, id]
    );
    await recordAuditLog({
      actor: auth,
      action: 'CORPORATE_ACCOUNT_UPDATED',
      entityType: 'CORPORATE',
      entityId: id,
      summary: `Updated corporate account '${acc.company_name}'`,
      req,
    });
    return NextResponse.json({ success: true, account: upd.rows[0] });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
