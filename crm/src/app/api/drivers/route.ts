import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { getRevenueProtectionPolicy } from '@/lib/settings';
import { validateOnboardingDocs } from '@/lib/driver-onboarding';
import { findDriverByPhones } from '@/lib/driver-edits';

export const dynamic = 'force-dynamic';

/** Matches text anywhere, with LIKE's own wildcard characters (% _ and the backslash) taken literally. */
function likePattern(text: string) {
  return `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

class PhoneTakenError extends Error {
  constructor(owner: { id: number; full_name: string; onboarding_status: string }) {
    super(`This number already belongs to driver ${owner.full_name} (#${owner.id}, ${owner.onboarding_status}). Use Edit on that driver instead.`);
  }
}

class VehicleTakenError extends Error {
  constructor(regNo: string) {
    super(`Vehicle ${regNo} is already on file for another driver, or was removed, so it cannot be added here`);
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'drivers.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const city = searchParams.get('city');
    const status = searchParams.get('status');
    const search = (searchParams.get('q') || '').trim().slice(0, 50);

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
      LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id AND v.removed_at IS NULL
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

    // Search: name or licence number contains the text; phone or registration number contains its
    // letters and digits, ignoring spaces and dashes (so "BR01PK" finds "BR-01-PK-9821").
    if (search) {
      params.push(likePattern(search));
      const textParam = `$${params.length}`;
      const conditions = [`d.full_name ILIKE ${textParam}`, `d.license_number ILIKE ${textParam}`];
      const alnum = search.replace(/[^A-Za-z0-9]/g, '');
      if (alnum) {
        params.push(likePattern(alnum));
        const alnumParam = `$${params.length}`;
        conditions.push(
          `d.phone LIKE ${alnumParam}`,
          `d.whatsapp_phone LIKE ${alnumParam}`,
          `EXISTS (SELECT 1 FROM crm_driver_vehicles sv WHERE sv.driver_id = d.id AND sv.removed_at IS NULL
                   AND regexp_replace(sv.registration_no, '[^A-Za-z0-9]', '', 'g') ILIKE ${alnumParam})`
        );
      }
      where.push(`(${conditions.join(' OR ')})`);
    }

    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }

    sql += ` GROUP BY d.id ORDER BY d.created_at DESC;`;

    const res = await query(sql, params);
    const revPolicy = await getRevenueProtectionPolicy();
    // Every city with a driver, for the city filter (not narrowed by the current filters).
    const cityRes = await query(`SELECT DISTINCT base_city FROM crm_drivers ORDER BY base_city`);

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

    return NextResponse.json({ success: true, drivers: enrichedDrivers, cities: cityRes.rows.map((r: any) => r.base_city) });
  } catch (err: any) {
    console.error('[Drivers] Loading drivers failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Loading drivers failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, 'drivers.manage');
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const {
      full_name,
      phone,
      whatsapp_phone,
      base_city,
      license_number,
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

    const checked = validateOnboardingDocs(body);
    if (!checked.ok) {
      return NextResponse.json({ success: false, error: checked.error }, { status: 400 });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');
    const cleanWa = String(whatsapp_phone || phone).replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(cleanPhone) || !/^\d{10,15}$/.test(cleanWa)) {
      return NextResponse.json(
        { success: false, error: 'phone and whatsapp_phone must have 10 to 15 digits, with country code (e.g. 917070992170)' },
        { status: 400 }
      );
    }

    // New drivers start PENDING_DOCS: they get rides only after staff activate them (migration 30).
    // An existing phone keeps its current status. Driver and vehicle are saved together or not at all.
    const docs = checked.docs;
    const result = await withTransaction(async (client) => {
      // A number already on file is refused, never overwritten (owner decision): staff change an
      // existing driver with Edit. The WhatsApp bot recognises a driver by either number.
      const owner = await findDriverByPhones(client, [...new Set([cleanPhone, cleanWa])]);
      if (owner) throw new PhoneTakenError(owner);
      const driverRes = await client.query(
        `INSERT INTO crm_drivers (
          full_name, phone, whatsapp_phone, base_city, onboarding_status,
          license_number, license_expiry, bank_upi_id, bank_account_number, bank_ifsc,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'PENDING_DOCS', $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          full_name,
          cleanPhone,
          cleanWa,
          base_city,
          license_number || null,
          docs.license_expiry,
          docs.bank_upi_id,
          bank_account_number || null,
          bank_ifsc || null,
        ]
      );
      const driver = driverRes.rows[0];

      let insertedVehicle = null;
      if (vehicle && vehicle.registration_no && vehicle.wp_vehicle_code && docs.vehicle) {
        const regNo = String(vehicle.registration_no).toUpperCase();
        // A registration held by another driver, or removed, is refused, never moved or changed.
        const vRes = await client.query(
          `INSERT INTO crm_driver_vehicles (
            driver_id, wp_vehicle_code, registration_no, model_name,
            insurance_expiry, fitness_expiry, permit_expiry, is_verified, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (registration_no) DO UPDATE
          SET wp_vehicle_code = EXCLUDED.wp_vehicle_code,
              model_name = EXCLUDED.model_name,
              insurance_expiry = EXCLUDED.insurance_expiry,
              fitness_expiry = EXCLUDED.fitness_expiry,
              permit_expiry = EXCLUDED.permit_expiry,
              updated_at = CURRENT_TIMESTAMP
          WHERE crm_driver_vehicles.driver_id = EXCLUDED.driver_id AND crm_driver_vehicles.removed_at IS NULL
          RETURNING *`,
          [
            driver.id,
            vehicle.wp_vehicle_code,
            regNo,
            vehicle.model_name || vehicle.wp_vehicle_code,
            docs.vehicle.insurance_expiry,
            docs.vehicle.fitness_expiry,
            docs.vehicle.permit_expiry,
          ]
        );
        if (vRes.rows.length === 0) throw new VehicleTakenError(regNo);
        insertedVehicle = vRes.rows[0];
      }
      return { driver, vehicle: insertedVehicle };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    if (err?.code === '23505' && err?.constraint === 'crm_drivers_phone_key') {
      return NextResponse.json({ success: false, error: 'That phone number was just registered to another driver. Use Edit on that driver.' }, { status: 409 });
    }
    if (err instanceof VehicleTakenError || err instanceof PhoneTakenError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
