import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import { normalizeReferralCode } from '@/lib/b2b-partners';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['HOTEL', 'TRAVEL_DESK', 'AGENT'] as const;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'partners.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await query(
      `SELECT
         p.*,
         (SELECT COUNT(*)::int FROM crm_bookings b WHERE b.partner_id = p.id) AS referred_bookings,
         (SELECT COALESCE(SUM(b.partner_commission_amount), 0) FROM crm_bookings b
          WHERE b.partner_id = p.id AND b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')) AS earned_commission
       FROM crm_partners p
       ORDER BY p.is_active DESC, p.id DESC`
    );
    return NextResponse.json({
      success: true,
      partners: res.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        commission_value: Number(r.commission_value),
        wallet_balance: Number(r.wallet_balance),
        earned_commission: Number(r.earned_commission),
      })),
    });
  } catch (err: any) {
    return handleRouteError(err, 'API partners');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'partners.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const partnerName = String(body.partner_name || '').trim().slice(0, 160);
    const partnerType = String(body.partner_type || 'HOTEL').trim().toUpperCase();
    const city = String(body.city || '').trim().slice(0, 100);
    const contactName = String(body.contact_name || '').trim().slice(0, 120);
    const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 20);
    const referralCode = normalizeReferralCode(body.referral_code);
    const commissionType = String(body.commission_type || 'PERCENT').trim().toUpperCase() === 'FLAT' ? 'FLAT' : 'PERCENT';
    const commissionValue = Math.max(0, Number(body.commission_value ?? 5));
    const upiId = body.upi_id ? String(body.upi_id).trim().slice(0, 100) : null;

    if (!partnerName || !city || !contactName || phone.length < 10 || referralCode.length < 3) {
      return NextResponse.json(
        { success: false, error: 'Partner name, city, contact, valid phone, and referral code (3+ chars) are required.' },
        { status: 400 }
      );
    }
    if (!(VALID_TYPES as readonly string[]).includes(partnerType)) {
      return NextResponse.json({ success: false, error: 'Invalid partner_type.' }, { status: 400 });
    }

    const ins = await query(
      `INSERT INTO crm_partners
         (partner_name, partner_type, city, contact_name, phone, referral_code, commission_type, commission_value, upi_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [partnerName, partnerType, city, contactName, phone, referralCode, commissionType, commissionValue, upiId]
    );
    const partner = ins.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'PARTNER_CREATED',
      entityType: 'PARTNER',
      entityId: partner.id,
      summary: `Created ${partnerType} partner '${partnerName}' (code: ${referralCode})`,
      afterData: { id: partner.id, partner_name: partnerName, referral_code: referralCode, commission_type: commissionType, commission_value: commissionValue },
      req,
    });

    return NextResponse.json({ success: true, partner: { ...partner, id: Number(partner.id) } }, { status: 201 });
  } catch (err: any) {
    if (err?.code === '23505') {
      return NextResponse.json({ success: false, error: 'Referral code already exists.' }, { status: 409 });
    }
    return handleRouteError(err, 'API partners');
  }
}
