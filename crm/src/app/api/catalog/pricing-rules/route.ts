import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const VALID_RULE_TYPES = ['NIGHT', 'FESTIVAL', 'PEAK_DATE', 'CITY_DEMAND'] as const;
const VALID_ADJ_TYPES = ['PERCENT', 'FLAT'] as const;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await query(`SELECT * FROM crm_pricing_rules ORDER BY priority DESC, id DESC`);
    return NextResponse.json({
      success: true,
      rules: res.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        adjustment_value: Number(r.adjustment_value),
        priority: Number(r.priority),
        start_date: r.start_date ? new Date(r.start_date).toISOString().slice(0, 10) : null,
        end_date: r.end_date ? new Date(r.end_date).toISOString().slice(0, 10) : null,
        start_time: r.start_time ? String(r.start_time).slice(0, 5) : null,
        end_time: r.end_time ? String(r.end_time).slice(0, 5) : null,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const name = String(body.name || '').trim().slice(0, 120);
    const ruleType = String(body.rule_type || 'FESTIVAL').trim().toUpperCase();
    const adjType = String(body.adjustment_type || 'PERCENT').trim().toUpperCase();
    const adjVal = Number(body.adjustment_value);
    const priority = Number.isInteger(Number(body.priority)) ? Number(body.priority) : 10;

    if (!name) return NextResponse.json({ success: false, error: 'Rule name is required.' }, { status: 400 });
    if (!(VALID_RULE_TYPES as readonly string[]).includes(ruleType)) {
      return NextResponse.json({ success: false, error: 'Invalid rule_type.' }, { status: 400 });
    }
    if (!(VALID_ADJ_TYPES as readonly string[]).includes(adjType)) {
      return NextResponse.json({ success: false, error: 'Invalid adjustment_type.' }, { status: 400 });
    }
    if (!Number.isFinite(adjVal) || adjVal <= 0) {
      return NextResponse.json({ success: false, error: 'adjustment_value must be greater than 0.' }, { status: 400 });
    }
    if (adjType === 'PERCENT' && adjVal > 100) {
      return NextResponse.json({ success: false, error: 'Percentage surge cannot exceed 100%.' }, { status: 400 });
    }

    const bookingType = body.booking_type ? String(body.booking_type).trim().toUpperCase() : null;
    const originCity = body.origin_city ? String(body.origin_city).trim().slice(0, 100) : null;
    const cabCategory = body.cab_category ? String(body.cab_category).trim().toUpperCase() : null;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || '')) ? String(body.start_date) : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || '')) ? String(body.end_date) : null;
    const startTime = /^\d{2}:\d{2}/.test(String(body.start_time || '')) ? String(body.start_time).slice(0, 5) : null;
    const endTime = /^\d{2}:\d{2}/.test(String(body.end_time || '')) ? String(body.end_time).slice(0, 5) : null;

    const ins = await query(
      `INSERT INTO crm_pricing_rules
         (name, rule_type, booking_type, origin_city, cab_category, start_date, end_date, start_time, end_time, adjustment_type, adjustment_value, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
       RETURNING *`,
      [name, ruleType, bookingType, originCity, cabCategory, startDate, endDate, startTime, endTime, adjType, adjVal, priority]
    );
    const rule = ins.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'PRICING_RULE_CREATED',
      entityType: 'CATALOG',
      entityId: rule.id,
      summary: `Created surge pricing rule '${name}' (${ruleType}: +${adjVal}${adjType === 'PERCENT' ? '%' : ' INR'})`,
      afterData: rule,
      req,
    });

    return NextResponse.json({ success: true, rule: { ...rule, id: Number(rule.id) } }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
