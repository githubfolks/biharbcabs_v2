import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { toCsv } from '@/lib/financial-reports';
import { recordAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * Consolidated Monthly Corporate B2B Statement (JSON or CSV annexure).
 * GET /api/corporate/[id]/statement?month=YYYY-MM&format=json|csv
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req, 'corporate.view');
  if (auth instanceof NextResponse) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid corporate account ID' }, { status: 400 });
  }

  const monthRaw = (req.nextUrl.searchParams.get('month') || '').trim();
  const defaultMonth = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : defaultMonth;
  const format = (req.nextUrl.searchParams.get('format') || 'json').toLowerCase();

  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fromTs = `${month}-01T00:00:00+05:30`;
  const toTs = `${month}-${String(lastDay).padStart(2, '0')}T23:59:59.999+05:30`;

  try {
    const accRes = await query(`SELECT * FROM crm_corporate_accounts WHERE id = $1 LIMIT 1`, [id]);
    if (accRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Corporate account not found' }, { status: 404 });
    }
    const account = accRes.rows[0];

    const tripsRes = await query(
      `SELECT
         b.booking_code,
         TO_CHAR(b.pickup_date, 'YYYY-MM-DD') AS pickup_date,
         c.full_name AS passenger_name,
         c.phone AS passenger_phone,
         b.trip_type,
         b.origin_city,
         b.destination_city,
         b.wp_vehicle_code,
         b.customer_total_fare,
         b.ride_gst_amount,
         (b.customer_total_fare - b.ride_gst_amount) AS taxable_value,
         i.invoice_number
       FROM crm_bookings b
       JOIN crm_customers c ON c.id = b.customer_id
       LEFT JOIN crm_invoices i ON i.booking_id = b.id
       WHERE b.corporate_account_id = $1
         AND b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
         AND b.created_at BETWEEN $2::timestamptz AND $3::timestamptz
       ORDER BY b.pickup_date ASC, b.id ASC`,
      [id, fromTs, toTs]
    );

    const rows = tripsRes.rows.map((r) => ({
      ...r,
      customer_total_fare: Number(r.customer_total_fare || 0),
      ride_gst_amount: Number(r.ride_gst_amount || 0),
      taxable_value: Number(r.taxable_value || 0),
    }));

    const totals = rows.reduce(
      (acc, r) => ({
        trips: acc.trips + 1,
        taxable_value: Math.round((acc.taxable_value + r.taxable_value) * 100) / 100,
        gst_amount: Math.round((acc.gst_amount + r.ride_gst_amount) * 100) / 100,
        total_amount: Math.round((acc.total_amount + r.customer_total_fare) * 100) / 100,
      }),
      { trips: 0, taxable_value: 0, gst_amount: 0, total_amount: 0 }
    );

    if (format === 'csv') {
      const csv = toCsv(
        [
          'Company',
          'GSTIN',
          'Month',
          'Booking Code',
          'Invoice Number',
          'Pickup Date',
          'Passenger',
          'Route',
          'Cab',
          'Taxable Value (INR)',
          'GST (INR)',
          'Total Fare (INR)',
        ],
        rows.map((r) => [
          account.company_name,
          account.gstin || '',
          month,
          r.booking_code,
          r.invoice_number || '',
          r.pickup_date,
          `${r.passenger_name || ''} (${r.passenger_phone})`,
          `${r.origin_city} -> ${r.destination_city || 'Local'}`,
          r.wp_vehicle_code,
          r.taxable_value,
          r.ride_gst_amount,
          r.customer_total_fare,
        ])
      );
      await recordAuditLog({
        actor: auth,
        action: 'CORPORATE_STATEMENT_EXPORTED',
        entityType: 'CORPORATE',
        entityId: id,
        summary: `Exported ${month} B2B statement CSV for '${account.company_name}' (${totals.trips} trips)`,
        req,
      });
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="biharcabs-b2b-${id}-${month}.csv"`,
        },
      });
    }

    return NextResponse.json({ success: true, account, month, totals, rows });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
