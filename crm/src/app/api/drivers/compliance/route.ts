import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Fleet Compliance & Document Expiry Monitor.
 * Returns drivers and vehicles whose DL, Insurance, Fitness, Permit, or PUC
 * is already expired or expiring within `days` (default 30).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const days = Math.min(180, Math.max(1, parseInt(req.nextUrl.searchParams.get('days') || '30', 10) || 30));

    const res = await query(
      `SELECT
         d.id AS driver_id,
         d.full_name,
         d.phone,
         d.base_city,
         d.onboarding_status,
         d.license_expiry,
         v.id AS vehicle_id,
         v.registration_no,
         v.model_name,
         v.insurance_expiry,
         v.fitness_expiry,
         v.permit_expiry,
         v.puc_expiry
       FROM crm_drivers d
       LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id
       WHERE d.onboarding_status IN ('APPROVED_ACTIVE', 'SUSPENDED', 'PENDING_DOCS')
         AND (
           (d.license_expiry IS NOT NULL AND d.license_expiry <= CURRENT_DATE + ($1 * INTERVAL '1 day'))
           OR (v.insurance_expiry IS NOT NULL AND v.insurance_expiry <= CURRENT_DATE + ($1 * INTERVAL '1 day'))
           OR (v.fitness_expiry IS NOT NULL AND v.fitness_expiry <= CURRENT_DATE + ($1 * INTERVAL '1 day'))
           OR (v.permit_expiry IS NOT NULL AND v.permit_expiry <= CURRENT_DATE + ($1 * INTERVAL '1 day'))
           OR (v.puc_expiry IS NOT NULL AND v.puc_expiry <= CURRENT_DATE + ($1 * INTERVAL '1 day'))
         )
       ORDER BY d.id ASC`,
      [days]
    );

    const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const alerts: Array<{
      driver_id: number;
      full_name: string;
      phone: string;
      base_city: string;
      onboarding_status: string;
      registration_no: string | null;
      document: string;
      expiry_date: string;
      severity: 'EXPIRED' | 'EXPIRING_SOON';
    }> = [];

    const checkDoc = (row: any, docName: string, rawDate: any) => {
      if (!rawDate) return;
      const iso = new Date(rawDate).toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() + (5.5 * 3600 + days * 86400) * 1000).toISOString().slice(0, 10);
      if (iso <= cutoff) {
        alerts.push({
          driver_id: Number(row.driver_id),
          full_name: row.full_name,
          phone: row.phone,
          base_city: row.base_city || '—',
          onboarding_status: row.onboarding_status,
          registration_no: row.registration_no || null,
          document: docName,
          expiry_date: iso,
          severity: iso < todayStr ? 'EXPIRED' : 'EXPIRING_SOON',
        });
      }
    };

    const seenDriverDl = new Set<number>();
    for (const row of res.rows) {
      const did = Number(row.driver_id);
      if (!seenDriverDl.has(did)) {
        seenDriverDl.add(did);
        checkDoc(row, 'Driving License', row.license_expiry);
      }
      if (row.vehicle_id) {
        checkDoc(row, 'Vehicle Insurance', row.insurance_expiry);
        checkDoc(row, 'Fitness Certificate', row.fitness_expiry);
        checkDoc(row, 'Permit', row.permit_expiry);
        checkDoc(row, 'PUC', row.puc_expiry);
      }
    }

    alerts.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));

    return NextResponse.json({
      success: true,
      window_days: days,
      summary: {
        total_alerts: alerts.length,
        expired_count: alerts.filter((a) => a.severity === 'EXPIRED').length,
        expiring_soon_count: alerts.filter((a) => a.severity === 'EXPIRING_SOON').length,
      },
      alerts,
    });
  } catch (err: any) {
    return handleRouteError(err, 'API drivers/compliance');
  }
}
