import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getRevenueProtectionPolicy } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const city = searchParams.get('city');
    const status = searchParams.get('status');

    let sql = `
      SELECT 
        d.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', v.id,
              'wp_vehicle_code', v.wp_vehicle_code,
              'registration_no', v.registration_no,
              'model_name', v.model_name,
              'insurance_expiry', v.insurance_expiry,
              'fitness_expiry', v.fitness_expiry,
              'permit_expiry', v.permit_expiry,
              'is_verified', v.is_verified
            )
          ) FILTER (WHERE v.id IS NOT NULL), '[]'::json
        ) AS vehicles
      FROM crm_drivers d
      LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id
    `;

    const where: string[] = [];
    const params: any[] = [];

    if (city) {
      params.push(city);
      where.push(`LOWER(d.base_city) = LOWER($${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`d.onboarding_status = $${params.length}`);
    }

    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }

    sql += ` GROUP BY d.id ORDER BY d.created_at DESC;`;

    const res = await query(sql, params);
    const revPolicy = await getRevenueProtectionPolicy();

    const enrichedDrivers = res.rows.map((d: any) => {
      const rating = Number(d.rating || 5.0);
      const trips = Number(d.total_trips_completed || 0);
      let tier: 'PROBATION' | 'STANDARD' | 'ELITE' = 'PROBATION';
      const limits = revPolicy.dynamic_credit_limits || { probation_or_new: 300, standard: 1000, elite: 2500 };
      let dynamicLimit = Number(limits.probation_or_new || 300);

      if (rating >= Number(revPolicy.elite_min_rating || 4.80) && trips >= Number(revPolicy.elite_min_trips || 25)) {
        tier = 'ELITE';
        dynamicLimit = Number(limits.elite || 2500);
      } else if (rating >= Number(revPolicy.standard_min_rating || 4.20)) {
        tier = 'STANDARD';
        dynamicLimit = Number(limits.standard || 1000);
      }

      return {
        ...d,
        credit_tier: tier,
        dynamic_credit_limit: dynamicLimit,
        target_security_reserve: Number(revPolicy.target_security_reserve || 500),
      };
    });

    return NextResponse.json({ success: true, drivers: enrichedDrivers });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      full_name,
      phone,
      whatsapp_phone,
      base_city,
      license_number,
      license_expiry,
      bank_upi_id,
      bank_account_number,
      bank_ifsc,
      vehicle, // { wp_vehicle_code, registration_no, model_name, insurance_expiry, fitness_expiry, permit_expiry }
    } = body;

    if (!full_name || !phone || !base_city) {
      return NextResponse.json(
        { success: false, error: 'full_name, phone, and base_city are mandatory' },
        { status: 400 }
      );
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const cleanWa = (whatsapp_phone || phone).replace(/\D/g, '');

    // 1. Insert driver
    const driverRes = await query(
      `INSERT INTO crm_drivers (
        full_name, phone, whatsapp_phone, base_city, onboarding_status,
        license_number, license_expiry, bank_upi_id, bank_account_number, bank_ifsc,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'APPROVED_ACTIVE', $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (phone) DO UPDATE
      SET full_name = EXCLUDED.full_name,
          whatsapp_phone = EXCLUDED.whatsapp_phone,
          base_city = EXCLUDED.base_city,
          license_number = COALESCE(EXCLUDED.license_number, crm_drivers.license_number),
          license_expiry = COALESCE(EXCLUDED.license_expiry, crm_drivers.license_expiry),
          updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        full_name,
        cleanPhone,
        cleanWa,
        base_city,
        license_number || null,
        license_expiry || null,
        bank_upi_id || null,
        bank_account_number || null,
        bank_ifsc || null,
      ]
    );

    const driver = driverRes.rows[0];

    // 2. Insert vehicle if provided
    let insertedVehicle = null;
    if (vehicle && vehicle.registration_no && vehicle.wp_vehicle_code) {
      const vRes = await query(
        `INSERT INTO crm_driver_vehicles (
          driver_id, wp_vehicle_code, registration_no, model_name,
          insurance_expiry, fitness_expiry, permit_expiry, is_verified, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (registration_no) DO UPDATE
        SET wp_vehicle_code = EXCLUDED.wp_vehicle_code,
            model_name = EXCLUDED.model_name,
            insurance_expiry = EXCLUDED.insurance_expiry,
            fitness_expiry = EXCLUDED.fitness_expiry,
            permit_expiry = EXCLUDED.permit_expiry,
            is_verified = true,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [
          driver.id,
          vehicle.wp_vehicle_code,
          vehicle.registration_no.toUpperCase(),
          vehicle.model_name || vehicle.wp_vehicle_code,
          vehicle.insurance_expiry || null,
          vehicle.fitness_expiry || null,
          vehicle.permit_expiry || null,
        ]
      );
      insertedVehicle = vRes.rows[0];
    }

    return NextResponse.json({
      success: true,
      driver,
      vehicle: insertedVehicle,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
