import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'corporate.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await query(
      `SELECT
         a.*,
         (SELECT COUNT(*)::int FROM crm_corporate_members m WHERE m.corporate_account_id = a.id AND m.is_active = true) AS members_count,
         (SELECT COUNT(*)::int FROM crm_bookings b WHERE b.corporate_account_id = a.id) AS bookings_count,
         (SELECT COALESCE(SUM(b.customer_total_fare), 0) FROM crm_bookings b
          WHERE b.corporate_account_id = a.id AND b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')) AS total_billed
       FROM crm_corporate_accounts a
       ORDER BY a.is_active DESC, a.company_name ASC`
    );
    return NextResponse.json({
      success: true,
      accounts: res.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        credit_limit: Number(r.credit_limit),
        current_outstanding: Number(r.current_outstanding),
        discount_pct: Number(r.discount_pct),
        total_billed: Number(r.total_billed),
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'corporate.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const companyName = String(body.company_name || '').trim().slice(0, 160);
    const contactName = String(body.contact_name || '').trim().slice(0, 120);
    const contactPhone = String(body.contact_phone || '').replace(/\D/g, '').slice(0, 20);
    const contactEmail = body.contact_email ? String(body.contact_email).trim().slice(0, 150) : null;
    const gstin = body.gstin ? String(body.gstin).trim().toUpperCase().slice(0, 20) : null;
    const billingAddress = body.billing_address ? String(body.billing_address).trim().slice(0, 500) : null;
    const creditLimit = Math.max(0, Number(body.credit_limit ?? 50000));
    const discountPct = Math.min(50, Math.max(0, Number(body.discount_pct ?? 0)));

    if (!companyName || !contactName || contactPhone.length < 10) {
      return NextResponse.json(
        { success: false, error: 'Company name, contact name, and valid phone are required.' },
        { status: 400 }
      );
    }

    const ins = await query(
      `INSERT INTO crm_corporate_accounts
         (company_name, gstin, billing_address, contact_name, contact_phone, contact_email, credit_limit, discount_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyName, gstin, billingAddress, contactName, contactPhone, contactEmail, creditLimit, discountPct]
    );
    const acc = ins.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'CORPORATE_ACCOUNT_CREATED',
      entityType: 'CORPORATE',
      entityId: acc.id,
      summary: `Created corporate B2B account '${companyName}' (limit ₹${creditLimit})`,
      afterData: { id: acc.id, company_name: companyName, gstin, credit_limit: creditLimit, discount_pct: discountPct },
      req,
    });

    return NextResponse.json({ success: true, account: { ...acc, id: Number(acc.id) } }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
