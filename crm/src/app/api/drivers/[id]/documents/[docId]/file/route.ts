import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import fs from 'fs';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { safeStoredFilenamePath } from '@/lib/driver-docs';

export const dynamic = 'force-dynamic';

/**
 * Private, RBAC-gated driver document download/preview.
 * Sensitive KYC files (Aadhaar, PAN, DL, RC) are NEVER served publicly.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string; docId: string } }) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;

  const driverId = Number(params.id);
  const docId = Number(params.docId);
  if (!Number.isInteger(driverId) || driverId <= 0 || !Number.isInteger(docId) || docId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid driver or document ID' }, { status: 400 });
  }

  try {
    const res = await query(
      `SELECT stored_filename, original_filename, mime_type
       FROM crm_driver_documents
       WHERE id = $1 AND driver_id = $2
       LIMIT 1`,
      [docId, driverId]
    );
    if (res.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 });
    }
    const row = res.rows[0];
    const filePath = safeStoredFilenamePath(row.stored_filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return NextResponse.json({ success: false, error: 'Document file missing on disk' }, { status: 404 });
    }

    const bytes = fs.readFileSync(filePath);
    const safeName = String(row.original_filename || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/[id]/documents/[docId]/file');
  }
}
