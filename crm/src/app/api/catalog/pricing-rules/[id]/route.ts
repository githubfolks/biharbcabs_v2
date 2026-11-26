import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid rule ID' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const isActive = body.is_active !== undefined ? Boolean(body.is_active) : undefined;
    if (isActive === undefined) {
      return NextResponse.json({ success: false, error: 'is_active is required' }, { status: 400 });
    }
    const upd = await query(
      `UPDATE crm_pricing_rules SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [isActive, id]
    );
    if (upd.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
    }

    await recordAuditLog({
      actor: auth,
      action: 'PRICING_RULE_UPDATED',
      entityType: 'CATALOG',
      entityId: id,
      summary: `${isActive ? 'Enabled' : 'Disabled'} surge rule '${upd.rows[0].name}'`,
      req,
    });

    return NextResponse.json({ success: true, rule: { ...upd.rows[0], id: Number(upd.rows[0].id) } });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/pricing-rules/[id]');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid rule ID' }, { status: 400 });
  }

  try {
    const del = await query(`DELETE FROM crm_pricing_rules WHERE id = $1 RETURNING id, name`, [id]);
    if (del.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
    }

    await recordAuditLog({
      actor: auth,
      action: 'PRICING_RULE_DELETED',
      entityType: 'CATALOG',
      entityId: id,
      summary: `Deleted surge pricing rule '${del.rows[0].name}'`,
      req,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return handleRouteError(err, 'API catalog/pricing-rules/[id]');
  }
}
