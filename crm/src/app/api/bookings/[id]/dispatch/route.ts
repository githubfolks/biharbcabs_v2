import { NextRequest, NextResponse } from 'next/server';
import { broadcastRideToDrivers, acceptRideOffer } from '@/lib/dispatch-engine';
import { query, withTransaction } from '@/lib/db';
import { settleReturnDiscountFunding } from '@/lib/return-trips';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const bookingId = parseInt(params.id, 10);
    const body = await req.json();
    const { action, driver_id } = body;

    if (action === 'broadcast' || action === 'rebroadcast') {
      const result = await broadcastRideToDrivers(bookingId);
      return NextResponse.json({ success: true, dispatch: result });
    }

    if (action === 'force_assign') {
      if (!driver_id) {
        return NextResponse.json(
          { success: false, error: 'driver_id required for force_assign' },
          { status: 400 }
        );
      }

      // 1. Fetch booking vehicle category
      const bRes = await query('SELECT wp_vehicle_code FROM crm_bookings WHERE id = $1', [bookingId]);
      if (bRes.rows.length === 0) {
        return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
      }

      const vehicleRes = await query(
        `SELECT id FROM crm_driver_vehicles 
         WHERE driver_id = $1 AND LOWER(wp_vehicle_code) = LOWER($2) AND is_verified = true
         LIMIT 1`,
        [driver_id, bRes.rows[0].wp_vehicle_code]
      );

      const vehicleId = vehicleRes.rows[0]?.id || null;

      await withTransaction(async (client) => {
        // Lock the booking, then apply the return-trip funding rule before assigning.
        const locked = await client.query('SELECT * FROM crm_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
        await settleReturnDiscountFunding(client, locked.rows[0], Number(driver_id));
        await client.query(
          `UPDATE crm_bookings
           SET assigned_driver_id = $1,
               assigned_vehicle_id = $2,
               booking_status = 'DRIVER_ASSIGNED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [driver_id, vehicleId, bookingId]
        );
      });

      return NextResponse.json({
        success: true,
        message: `Driver #${driver_id} manually assigned to booking #${bookingId}`,
      });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action. Supported: broadcast, force_assign' },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

