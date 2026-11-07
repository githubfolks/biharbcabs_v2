import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calculateFareSplit, calculateRideSplitWithTaxes, broadcastRideToDrivers } from '@/lib/dispatch-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    let sql = `
      SELECT 
        b.*,
        c.full_name AS customer_name,
        c.phone AS customer_phone,
        d.full_name AS driver_name,
        d.phone AS driver_phone,
        d.onboarding_status AS driver_status,
        v.model_name AS vehicle_model,
        v.registration_no AS vehicle_reg
      FROM crm_bookings b
      JOIN crm_customers c ON c.id = b.customer_id
      LEFT JOIN crm_drivers d ON d.id = b.assigned_driver_id
      LEFT JOIN crm_driver_vehicles v ON v.id = b.assigned_vehicle_id
    `;

    const params: any[] = [];
    if (status) {
      params.push(status);
      sql += ` WHERE b.booking_status = $1`;
    }

    sql += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query(sql, params);
    return NextResponse.json({ success: true, bookings: res.rows });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      customer_phone,
      customer_name,
      trip_type,
      origin_city,
      destination_city,
      pickup_address,
      drop_address,
      pickup_date,
      pickup_time,
      wp_vehicle_code,
      distance_km,
      customer_total_fare,
      auto_broadcast,
    } = body;

    if (!customer_phone || !origin_city || !pickup_date || !pickup_time || !wp_vehicle_code) {
      return NextResponse.json(
        { success: false, error: 'Missing mandatory booking fields' },
        { status: 400 }
      );
    }

    // 1. Upsert customer
    const cleanPhone = customer_phone.replace(/\D/g, '');
    const custRes = await query(
      `INSERT INTO crm_customers (phone, full_name, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (phone) DO UPDATE
       SET full_name = COALESCE(EXCLUDED.full_name, crm_customers.full_name),
           updated_at = CURRENT_TIMESTAMP
       RETURNING id, full_name, phone`,
      [cleanPhone, customer_name || 'Customer']
    );
    const customer = custRes.rows[0];

    // 2. Calculate dynamic commission, statutory GST, tech fee, advance token and driver payout
    const fare = Number(customer_total_fare || 0);
    const taxSplit = await calculateRideSplitWithTaxes(fare);

    // 3. Generate unique booking code e.g. BC-1042
    const codeNum = Math.floor(1000 + Math.random() * 9000);
    const bookingCode = `BC-${codeNum}`;

    const initialStatus = auto_broadcast ? 'AWAITING_DRIVER' : 'CONFIRMED_AWAITING_DRIVER';

    // 4. Insert booking with revenue protection & tax fields
    const bookRes = await query(
      `INSERT INTO crm_bookings (
        booking_code, customer_id, trip_type, origin_city, destination_city,
        pickup_address, drop_address, pickup_date, pickup_time, wp_vehicle_code,
        distance_km, customer_total_fare, driver_payout_amount, commission_amount,
        gst_amount, tech_fee_amount, advance_paid, balance_cash_due_from_customer,
        booking_status, payment_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        bookingCode,
        customer.id,
        trip_type || 'oneway',
        origin_city,
        destination_city || null,
        pickup_address || `${origin_city} Central`,
        drop_address || destination_city || null,
        pickup_date,
        pickup_time,
        wp_vehicle_code,
        distance_km || 0,
        fare,
        taxSplit.driverGrossEarnings,
        taxSplit.totalCompanyDuesZ,
        taxSplit.gstAmount,
        taxSplit.techFeeAmount,
        taxSplit.advanceTokenAmount,
        taxSplit.balanceCashDueFromCustomer,
        initialStatus,
      ]
    );

    const booking = bookRes.rows[0];

    let dispatchResult = null;
    if (auto_broadcast) {
      dispatchResult = await broadcastRideToDrivers(booking.id);
    }

    return NextResponse.json({
      success: true,
      booking,
      dispatch: dispatchResult,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
