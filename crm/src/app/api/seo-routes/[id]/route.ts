import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid SEO route ID' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const isPublished = body.is_published !== undefined ? Boolean(body.is_published) : undefined;
    if (isPublished === undefined) {
      return NextResponse.json({ success: false, error: 'is_published is required' }, { status: 400 });
    }
    const upd = await query(
      `UPDATE crm_seo_routes SET is_published = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [isPublished, id]
    );
    if (upd.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'SEO route not found' }, { status: 404 });
    }

    await recordAuditLog({
      actor: auth,
      action: 'SEO_ROUTE_UPDATED',
      entityType: 'SEO_ROUTE',
      entityId: id,
      summary: `${isPublished ? 'Published' : 'Unpublished'} SEO route /cab/${upd.rows[0].slug}/`,
      req,
    });

    return NextResponse.json({ success: true, route: { ...upd.rows[0], id: Number(upd.rows[0].id) } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'catalog.manage');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid SEO route ID' }, { status: 400 });
  }

  try {
    const del = await query(`DELETE FROM crm_seo_routes WHERE id = $1 RETURNING id, slug`, [id]);
    if (del.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'SEO route not found' }, { status: 404 });
    }
    await recordAuditLog({
      actor: auth,
      action: 'SEO_ROUTE_DELETED',
      entityType: 'SEO_ROUTE',
      entityId: id,
      summary: `Deleted SEO route /cab/${del.rows[0].slug}/`,
      req,
    });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
