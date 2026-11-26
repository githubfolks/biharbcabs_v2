import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'dispatch.manage');
  if (auth instanceof NextResponse) return auth;

  const ticketId = Number(params.id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid ticket ID' }, { status: 400 });
  }

  try {
    const existing = await query(`SELECT id, status, summary FROM crm_support_tickets WHERE id = $1 LIMIT 1`, [ticketId]);
    if (existing.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Ticket not found' }, { status: 404 });
    }
    const before = existing.rows[0];
    const body = await req.json();

    const nextStatus = body.status ? String(body.status).trim().toUpperCase() : before.status;
    if (!(VALID_STATUSES as readonly string[]).includes(nextStatus)) {
      return NextResponse.json({ success: false, error: 'Invalid status' }, { status: 400 });
    }
    const resolutionNotes =
      body.resolution_notes !== undefined ? String(body.resolution_notes || '').trim().slice(0, 1000) || null : null;

    const isResolved = nextStatus === 'RESOLVED';
    const resolvedBy = isResolved ? auth.id : null;
    const resolvedAt = isResolved ? new Date().toISOString() : null;

    const upd = await query(
      `UPDATE crm_support_tickets
       SET status = $1,
           resolution_notes = COALESCE($2, resolution_notes),
           resolved_by = $3,
           resolved_at = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [nextStatus, resolutionNotes, resolvedBy, resolvedAt, ticketId]
    );

    await recordAuditLog({
      actor: auth,
      action: isResolved ? 'SUPPORT_TICKET_RESOLVED' : 'SUPPORT_TICKET_UPDATED',
      entityType: 'SUPPORT_TICKET',
      entityId: ticketId,
      summary: `Support ticket #${ticketId} marked ${nextStatus}`,
      beforeData: { status: before.status },
      afterData: { status: nextStatus, resolution_notes: resolutionNotes },
      req,
    });

    return NextResponse.json({ success: true, ticket: { ...upd.rows[0], id: Number(upd.rows[0].id) } });
  } catch (err: any) {
    return handleRouteError(err, 'API support-tickets/[id]');
  }
}
