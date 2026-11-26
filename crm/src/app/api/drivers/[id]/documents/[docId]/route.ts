import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import fs from 'fs';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import { safeStoredFilenamePath } from '@/lib/driver-docs';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string; docId: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;

  const driverId = Number(params.id);
  const docId = Number(params.docId);
  if (!Number.isInteger(driverId) || driverId <= 0 || !Number.isInteger(docId) || docId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid driver or document ID' }, { status: 400 });
  }

  try {
    const existingRes = await query(
      `SELECT id, driver_id, doc_type, doc_number, expiry_date, verification_status, rejection_reason
       FROM crm_driver_documents WHERE id = $1 AND driver_id = $2 LIMIT 1`,
      [docId, driverId]
    );
    if (existingRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 });
    }
    const before = existingRes.rows[0];
    const body = await req.json();

    const nextStatus = body.verification_status
      ? String(body.verification_status).trim().toUpperCase()
      : before.verification_status;
    if (!(VALID_STATUSES as readonly string[]).includes(nextStatus)) {
      return NextResponse.json({ success: false, error: 'Invalid verification_status' }, { status: 400 });
    }

    const nextReason =
      nextStatus === 'REJECTED'
        ? String(body.rejection_reason || before.rejection_reason || 'Document unclear or invalid').trim().slice(0, 500)
        : null;
    const nextDocNumber =
      body.doc_number !== undefined ? String(body.doc_number || '').trim().slice(0, 80) || null : before.doc_number;
    const nextExpiry =
      body.expiry_date !== undefined
        ? (/^\d{4}-\d{2}-\d{2}$/.test(String(body.expiry_date || '').trim()) ? String(body.expiry_date).trim() : null)
        : before.expiry_date;

    const isReviewed = nextStatus === 'VERIFIED' || nextStatus === 'REJECTED';
    const verifiedBy = isReviewed ? auth.id : null;
    const verifiedAt = isReviewed ? new Date().toISOString() : null;

    const upd = await query(
      `UPDATE crm_driver_documents
       SET verification_status = $1,
           rejection_reason = $2,
           doc_number = $3,
           expiry_date = $4,
           verified_by = $5,
           verified_at = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND driver_id = $8
       RETURNING id, driver_id, doc_type, doc_number, expiry_date, verification_status, verified_at, rejection_reason`,
      [nextStatus, nextReason, nextDocNumber, nextExpiry, verifiedBy, verifiedAt, docId, driverId]
    );

    await recordAuditLog({
      actor: auth,
      action:
        nextStatus === 'VERIFIED'
          ? 'DRIVER_DOC_VERIFIED'
          : nextStatus === 'REJECTED'
            ? 'DRIVER_DOC_REJECTED'
            : 'DRIVER_DOC_UPDATED',
      entityType: 'DRIVER_DOCUMENT',
      entityId: docId,
      summary: `Marked ${before.doc_type} for Driver #${driverId} as ${nextStatus}`,
      beforeData: { verification_status: before.verification_status, doc_number: before.doc_number },
      afterData: { verification_status: nextStatus, rejection_reason: nextReason, doc_number: nextDocNumber },
      req,
    });

    return NextResponse.json({ success: true, document: upd.rows[0] });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/documents/[docId]');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; docId: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;

  const driverId = Number(params.id);
  const docId = Number(params.docId);
  if (!Number.isInteger(driverId) || driverId <= 0 || !Number.isInteger(docId) || docId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid driver or document ID' }, { status: 400 });
  }

  try {
    const del = await query(
      `DELETE FROM crm_driver_documents WHERE id = $1 AND driver_id = $2 RETURNING id, doc_type, stored_filename`,
      [docId, driverId]
    );
    if (del.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 });
    }
    const row = del.rows[0];
    const filePath = safeStoredFilenamePath(row.stored_filename);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await recordAuditLog({
      actor: auth,
      action: 'DRIVER_DOC_DELETED',
      entityType: 'DRIVER_DOCUMENT',
      entityId: docId,
      summary: `Deleted ${row.doc_type} for Driver #${driverId}`,
      req,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/documents/[docId]');
  }
}
