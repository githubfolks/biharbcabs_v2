import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'audit.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action')?.trim() || '';
    const entityType = searchParams.get('entity_type')?.trim() || '';
    const q = searchParams.get('q')?.trim() || '';
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100));

    const where: string[] = [];
    const params: unknown[] = [];

    if (action) {
      params.push(action);
      where.push(`action = $${params.length}`);
    }
    if (entityType) {
      params.push(entityType);
      where.push(`entity_type = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(summary ILIKE $${params.length} OR COALESCE(actor_email, '') ILIKE $${params.length} OR COALESCE(actor_name, '') ILIKE $${params.length} OR COALESCE(entity_id, '') ILIKE $${params.length} OR COALESCE(ip_address, '') ILIKE $${params.length})`
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);

    const [logsRes, facetsRes] = await Promise.all([
      query(
        `SELECT id, actor_id, actor_email, actor_name, actor_role, action, entity_type, entity_id,
                summary, before_data, after_data, ip_address, user_agent, created_at
         FROM crm_audit_logs
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      ),
      query(
        `SELECT
           ARRAY(SELECT DISTINCT action FROM crm_audit_logs ORDER BY action) AS actions,
           ARRAY(SELECT DISTINCT entity_type FROM crm_audit_logs ORDER BY entity_type) AS entity_types`
      ),
    ]);

    return NextResponse.json({
      success: true,
      logs: logsRes.rows,
      facets: {
        actions: facetsRes.rows[0]?.actions || [],
        entity_types: facetsRes.rows[0]?.entity_types || [],
      },
    });
  } catch (err: any) {
    return handleRouteError(err, 'API audit');
  }
}
