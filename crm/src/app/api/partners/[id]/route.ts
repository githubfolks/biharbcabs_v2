import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid partner ID' }, { status: 400 });
  }

  try {
    const body = await req.json();

    // Payout recording requires partners.payout (FINANCE_MANAGER / SUPER_ADMIN)
    if (body.record_payout) {
      const auth = await requireAdmin(req, 'partners.payout');
      if (auth instanceof NextResponse) return auth;

      const amount = Number(body.record_payout.amount);
      const reference = String(body.record_payout.reference || '').trim().slice(0, 100);
      const channel = String(body.record_payout.channel || 'UPI').trim().toUpperCase().slice(0, 30);
      if (!Number.isFinite(amount) || amount <= 0 || reference.length < 4) {
        return NextResponse.json({ success: false, error: 'Valid payout amount and UTR/reference required.' }, { status: 400 });
      }

      const upd = await query(
        `UPDATE crm_partners
         SET wallet_balance = wallet_balance - $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [amount, id]
      );
      if (upd.rows.length === 0) {
        return NextResponse.json({ success: false, error: 'Partner not found' }, { status: 404 });
      }

      await query(
        `INSERT INTO crm_payments_ledger (transaction_type, direction, payment_channel, amount, reference_id, notes, recorded_by)
         VALUES ('PARTNER_PAYOUT_SENT', 'DEBIT', $1, $2, $3, $4, $5)`,
        [channel, amount, reference, `Partner payout to ${upd.rows[0].partner_name} (#${id})`, auth.id]
      );

      await recordAuditLog({
        actor: auth,
        action: 'PARTNER_PAYOUT_RECORDED',
        entityType: 'PARTNER',
        entityId: id,
        summary: `Recorded ₹${amount} payout to partner '${upd.rows[0].partner_name}' (${channel} Ref: ${reference})`,
        req,
      });

      return NextResponse.json({ success: true, partner: { ...upd.rows[0], id: Number(upd.rows[0].id) } });
    }

    const auth = await requireAdmin(req, 'partners.manage');
    if (auth instanceof NextResponse) return auth;

    const existing = await query(`SELECT * FROM crm_partners WHERE id = $1 LIMIT 1`, [id]);
    if (existing.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Partner not found' }, { status: 404 });
    }
    const p = existing.rows[0];
    const nextActive = body.is_active !== undefined ? Boolean(body.is_active) : p.is_active;
    const nextCommission = body.commission_value !== undefined ? Math.max(0, Number(body.commission_value)) : Number(p.commission_value);

    const upd = await query(
      `UPDATE crm_partners SET is_active = $1, commission_value = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [nextActive, nextCommission, id]
    );

    await recordAuditLog({
      actor: auth,
      action: 'PARTNER_UPDATED',
      entityType: 'PARTNER',
      entityId: id,
      summary: `Updated partner '${p.partner_name}' (active=${nextActive}, commission=${nextCommission})`,
      req,
    });

    return NextResponse.json({ success: true, partner: { ...upd.rows[0], id: Number(upd.rows[0].id) } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
