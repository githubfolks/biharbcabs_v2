import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { query } from '@/lib/db';
import { completeTripAndSettle, FinalBillingInput } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const filterType = searchParams.get('type');

    let sql = `
      SELECT 
        l.*,
        d.full_name AS driver_name,
        c.full_name AS customer_name
      FROM crm_payments_ledger l
      LEFT JOIN crm_drivers d ON d.id = l.driver_id
      LEFT JOIN crm_customers c ON c.id = l.customer_id
    `;

    const params: any[] = [];
    if (filterType && filterType !== 'ALL') {
      params.push(filterType);
      sql += ` WHERE l.transaction_type = $1`;
    }

    sql += ` ORDER BY l.created_at DESC LIMIT 100;`;

    const res = await query(sql, params);

    // Calculate aggregated financial summary KPIs
    const kpiRes = await query(`
      SELECT
        COALESCE(SUM(b.commission_amount), 0) AS total_commission_revenue,
        COALESCE(SUM(b.gst_amount + b.ride_gst_amount), 0) AS total_gst_statutory_collected,
        -- Its two parts: 5% GST on the ride fare (BiharCabs liable, CGST Sec 9(5)) and 18% GST on the
        -- commission + tech fee charged to drivers.
        COALESCE(SUM(b.ride_gst_amount), 0) AS total_ride_gst,
        COALESCE(SUM(b.gst_amount), 0) AS total_commission_gst,
        COALESCE(SUM(b.tech_fee_amount), 0) AS total_tech_fees_collected,
        COALESCE((SELECT SUM(security_reserve_balance) FROM crm_drivers), 0) AS total_security_reserve_held,
        COALESCE((SELECT SUM(ABS(wallet_balance)) FROM crm_drivers WHERE wallet_balance < 0), 0) AS total_driver_dues_outstanding,
        COALESCE((SELECT SUM(amount) FROM crm_payments_ledger WHERE transaction_type IN ('INCENTIVE_BONUS', 'INCENTIVE_STREAK_BONUS')), 0) AS total_incentives_awarded
      FROM crm_bookings b
      -- Completed rides only (owner decision): commission, GST and fees are counted once the trip is done,
      -- not while a ride is only assigned or in progress. COMPLETED_SETTLED is what settlement sets.
      WHERE b.booking_status IN ('COMPLETED_SETTLED', 'COMPLETED_UNBILLED')
    `);

    const summary = kpiRes.rows[0] ? {
      totalCommissionRevenue: parseFloat(Number(kpiRes.rows[0].total_commission_revenue).toFixed(2)),
      totalGstStatutory: parseFloat(Number(kpiRes.rows[0].total_gst_statutory_collected).toFixed(2)),
      totalRideGst: parseFloat(Number(kpiRes.rows[0].total_ride_gst).toFixed(2)),
      totalCommissionGst: parseFloat(Number(kpiRes.rows[0].total_commission_gst).toFixed(2)),
      totalTechFees: parseFloat(Number(kpiRes.rows[0].total_tech_fees_collected).toFixed(2)),
      totalSecurityReserveHeld: parseFloat(Number(kpiRes.rows[0].total_security_reserve_held).toFixed(2)),
      totalDriverDuesOutstanding: parseFloat(Number(kpiRes.rows[0].total_driver_dues_outstanding).toFixed(2)),
      totalIncentivesAwarded: parseFloat(Number(kpiRes.rows[0].total_incentives_awarded).toFixed(2)),
    } : {
      totalCommissionRevenue: 0,
      totalGstStatutory: 0,
      totalRideGst: 0,
      totalCommissionGst: 0,
      totalTechFees: 0,
      totalSecurityReserveHeld: 0,
      totalDriverDuesOutstanding: 0,
      totalIncentivesAwarded: 0,
    };

    return NextResponse.json({
      success: true,
      ledger: res.rows,
      summary,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.settle');
  if (auth instanceof NextResponse) return auth;
  try {
    const body: FinalBillingInput = await req.json();

    if (!body.bookingId) {
      return NextResponse.json({ success: false, error: 'bookingId is required' }, { status: 400 });
    }

    const result = await completeTripAndSettle(body);
    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
