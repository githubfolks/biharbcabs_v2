import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import {
  ALLOWED_DOC_MIME_EXT,
  MAX_DRIVER_DOC_BYTES,
  VALID_DOC_TYPE_CODES,
  getDriverDocsDir,
} from '@/lib/driver-docs';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;

  const driverId = Number(params.id);
  if (!Number.isInteger(driverId) || driverId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
  }

  try {
    const res = await query(
      `SELECT
         doc.id,
         doc.driver_id,
         doc.vehicle_id,
         doc.doc_type,
         doc.doc_number,
         doc.expiry_date,
         doc.original_filename,
         doc.mime_type,
         doc.size_bytes,
         doc.verification_status,
         doc.verified_at,
         doc.rejection_reason,
         doc.created_at,
         v.registration_no AS vehicle_reg,
         up.full_name AS uploaded_by_name,
         ver.full_name AS verified_by_name
       FROM crm_driver_documents doc
       LEFT JOIN crm_driver_vehicles v ON v.id = doc.vehicle_id
       LEFT JOIN crm_admin_users up ON up.id = doc.uploaded_by
       LEFT JOIN crm_admin_users ver ON ver.id = doc.verified_by
       WHERE doc.driver_id = $1
       ORDER BY doc.created_at DESC, doc.id DESC`,
      [driverId]
    );

    return NextResponse.json({
      success: true,
      documents: res.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        driver_id: Number(r.driver_id),
        vehicle_id: r.vehicle_id ? Number(r.vehicle_id) : null,
        file_url: `/api/drivers/${driverId}/documents/${r.id}/file`,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;

  const driverId = Number(params.id);
  if (!Number.isInteger(driverId) || driverId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid driver ID' }, { status: 400 });
  }

  try {
    const driverCheck = await query(`SELECT id, full_name FROM crm_drivers WHERE id = $1 LIMIT 1`, [driverId]);
    if (driverCheck.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Driver not found' }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const docType = String(formData.get('doc_type') || '').trim().toUpperCase();
    const docNumber = String(formData.get('doc_number') || '').trim().slice(0, 80) || null;
    const expiryRaw = String(formData.get('expiry_date') || '').trim();
    const expiryDate = /^\d{4}-\d{2}-\d{2}$/.test(expiryRaw) ? expiryRaw : null;
    const vehicleIdRaw = String(formData.get('vehicle_id') || '').trim();
    const vehicleId = vehicleIdRaw ? Number(vehicleIdRaw) : null;

    if (!VALID_DOC_TYPE_CODES.has(docType)) {
      return NextResponse.json({ success: false, error: 'Invalid document type.' }, { status: 400 });
    }
    if (vehicleId !== null && (!Number.isInteger(vehicleId) || vehicleId <= 0)) {
      return NextResponse.json({ success: false, error: 'Invalid vehicle_id.' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'Please attach a document file (JPG, PNG, WebP, or PDF).' }, { status: 400 });
    }

    const mime = (file.type || '').toLowerCase();
    const ext = ALLOWED_DOC_MIME_EXT[mime];
    if (!ext) {
      return NextResponse.json(
        { success: false, error: 'Unsupported file type. Allowed: JPG, PNG, WebP, PDF.' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: 'Uploaded file is empty.' }, { status: 400 });
    }
    if (buffer.length > MAX_DRIVER_DOC_BYTES) {
      return NextResponse.json({ success: false, error: 'File exceeds maximum allowed size of 5 MB.' }, { status: 400 });
    }

    const storedFilename = `drv_${driverId}_${docType.toLowerCase()}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const targetPath = path.join(getDriverDocsDir(), storedFilename);
    fs.writeFileSync(targetPath, buffer, { mode: 0o600 });

    const originalFilename = path.basename(file.name || `document${ext}`).slice(0, 255);

    const ins = await query(
      `INSERT INTO crm_driver_documents
         (driver_id, vehicle_id, doc_type, doc_number, expiry_date, original_filename, stored_filename, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, driver_id, vehicle_id, doc_type, doc_number, expiry_date, original_filename, mime_type, size_bytes, verification_status, created_at`,
      [driverId, vehicleId, docType, docNumber, expiryDate, originalFilename, storedFilename, mime, buffer.length, auth.id]
    );
    const doc = ins.rows[0];

    await recordAuditLog({
      actor: auth,
      action: 'DRIVER_DOC_UPLOADED',
      entityType: 'DRIVER_DOCUMENT',
      entityId: doc.id,
      summary: `Uploaded ${docType} for Driver #${driverId} (${driverCheck.rows[0].full_name})`,
      afterData: { driver_id: driverId, doc_type: docType, doc_number: docNumber, expiry_date: expiryDate, size_bytes: buffer.length },
      req,
    });

    return NextResponse.json(
      {
        success: true,
        document: {
          ...doc,
          id: Number(doc.id),
          driver_id: Number(doc.driver_id),
          file_url: `/api/drivers/${driverId}/documents/${doc.id}/file`,
        },
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
