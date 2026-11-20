/**
 * Editing a driver's details, payout details and vehicles after onboarding (migration 31).
 * Every change is recorded in crm_driver_edits with the admin and the old and new values, in the same
 * transaction as the change. A request that changes nothing records nothing.
 */
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { isIsoDate, isUpiId } from './driver-onboarding';

export class DriverEditError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
type Values = Record<string, string | null>;

const PHONE = /^\d{10,15}$/;
const VEHICLE_CODE = /^[a-z0-9_-]{1,64}$/;
const REG_NO = /^[A-Z0-9][A-Z0-9 -]{3,19}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NO = /^\d{6,20}$/;
const VEHICLE_DATES = ['insurance_expiry', 'fitness_expiry', 'permit_expiry'] as const;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null ? '' : undefined);

/** Driver details staff with drivers.manage may change. Only the fields sent are changed. */
export function parseDriverDetails(body: any): Parsed<Values> {
  const out: Values = {};
  const errors: string[] = [];
  const b = body || {};

  for (const [field, max] of [['full_name', 150], ['base_city', 100]] as const) {
    const v = text(b[field]);
    if (v === undefined) continue;
    if (!v || v.length > max) errors.push(`${field} is required (up to ${max} characters)`);
    else out[field] = v;
  }
  for (const field of ['phone', 'whatsapp_phone'] as const) {
    const v = text(b[field]);
    if (v === undefined) continue;
    const digits = v.replace(/\D/g, '');
    if (!PHONE.test(digits)) errors.push(`${field} must have 10 to 15 digits, with country code (e.g. 917070992170)`);
    else out[field] = digits;
  }
  const lic = text(b.license_number);
  if (lic !== undefined) {
    if (lic.length > 50) errors.push('license_number is up to 50 characters');
    else out.license_number = lic ? lic.toUpperCase() : null;
  }
  if (b.license_expiry !== undefined) {
    if (!isIsoDate(b.license_expiry)) errors.push('license_expiry must be a date (YYYY-MM-DD)');
    else out.license_expiry = b.license_expiry;
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  if (Object.keys(out).length === 0) return { ok: false, error: 'No driver details sent' };
  return { ok: true, value: out };
}

/** UPI ID, bank account and IFSC (drivers.payout_details). An empty value clears the field. */
export function parsePayoutDetails(body: any): Parsed<Values> {
  const out: Values = {};
  const errors: string[] = [];
  const b = body || {};

  const upi = text(b.bank_upi_id);
  if (upi !== undefined) {
    if (upi && !isUpiId(upi)) errors.push('bank_upi_id is not a valid UPI ID (e.g. name@bank)');
    else out.bank_upi_id = upi || null;
  }
  const acc = text(b.bank_account_number);
  if (acc !== undefined) {
    const digits = acc.replace(/\s/g, '');
    if (digits && !ACCOUNT_NO.test(digits)) errors.push('bank_account_number must be 6 to 20 digits');
    else out.bank_account_number = digits || null;
  }
  const ifsc = text(b.bank_ifsc);
  if (ifsc !== undefined) {
    const v = ifsc.toUpperCase();
    if (v && !IFSC.test(v)) errors.push('bank_ifsc must be 11 characters: 4 letters, 0, then 6 letters or digits');
    else out.bank_ifsc = v || null;
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  if (Object.keys(out).length === 0) return { ok: false, error: 'No payout details sent' };
  return { ok: true, value: out };
}

/**
 * A vehicle to add (registration number and all three dates required) or the changes to one
 * (registration number cannot change; only the fields sent are changed).
 */
export function parseVehicleInput(body: any, mode: 'add' | 'edit'): Parsed<Values> {
  const out: Values = {};
  const errors: string[] = [];
  const b = body || {};

  if (mode === 'add') {
    const reg = (text(b.registration_no) || '').toUpperCase();
    if (!REG_NO.test(reg)) errors.push('registration_no must be 4 to 20 letters, digits, spaces or dashes');
    else out.registration_no = reg;
  } else if (b.registration_no !== undefined) {
    errors.push('registration_no cannot be changed; remove the vehicle and add the new one');
  }

  const code = text(b.wp_vehicle_code);
  if (code !== undefined || mode === 'add') {
    const v = (code || '').toLowerCase();
    if (!VEHICLE_CODE.test(v)) errors.push('wp_vehicle_code is required (letters, digits, - or _)');
    else out.wp_vehicle_code = v;
  }
  const model = text(b.model_name);
  if (model !== undefined || mode === 'add') {
    if (!model || model.length > 100) errors.push('model_name is required (up to 100 characters)');
    else out.model_name = model;
  }
  for (const f of VEHICLE_DATES) {
    if (b[f] === undefined && mode === 'edit') continue;
    if (!isIsoDate(b[f])) errors.push(`${f} must be a date (YYYY-MM-DD)`);
    else out[f] = b[f];
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  if (Object.keys(out).length === 0) return { ok: false, error: 'No vehicle changes sent' };
  return { ok: true, value: out };
}

export function maskAccount(v: string | null): string | null {
  return v ? `****${String(v).slice(-4)}` : null;
}

/** Fields whose value differs, as { field: { from, to } }. */
export function diffValues(current: Values, next: Values) {
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const [k, to] of Object.entries(next)) {
    const from = current[k] ?? null;
    if ((from ?? null) !== (to ?? null)) changes[k] = { from, to };
  }
  return changes;
}

async function record(
  client: PoolClient,
  e: { driverId: number; vehicleId?: number | null; action: string; changes: object; reason?: string | null; adminId: number }
) {
  await client.query(
    `INSERT INTO crm_driver_edits (driver_id, vehicle_id, action, changes, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.driverId, e.vehicleId ?? null, e.action, JSON.stringify(e.changes), e.reason || null, e.adminId]
  );
}

async function lockDriver(client: PoolClient, driverId: number) {
  const r = await client.query(
    `SELECT id, full_name, phone, whatsapp_phone, base_city, license_number,
            to_char(license_expiry, 'YYYY-MM-DD') AS license_expiry, bank_upi_id, bank_account_number, bank_ifsc
     FROM crm_drivers WHERE id = $1 FOR UPDATE`,
    [driverId]
  );
  if (r.rows.length === 0) throw new DriverEditError('Driver not found', 404);
  return r.rows[0] as Values;
}

// Column names come only from these lists, never from the request.
const DRIVER_COLUMNS = ['full_name', 'phone', 'whatsapp_phone', 'base_city', 'license_number', 'license_expiry'];
const PAYOUT_COLUMNS = ['bank_upi_id', 'bank_account_number', 'bank_ifsc'];
const VEHICLE_COLUMNS = ['wp_vehicle_code', 'model_name', ...VEHICLE_DATES];

function setClause(changes: Record<string, unknown>, allowed: string[], firstParam: number) {
  const cols = Object.keys(changes).filter((c) => allowed.includes(c));
  return { sql: cols.map((c, i) => `${c} = $${firstParam + i}`).join(', '), cols };
}

async function updateDriverColumns(
  driverId: number,
  values: Values,
  allowed: string[],
  action: 'DRIVER_EDIT' | 'PAYOUT_DETAILS_EDIT',
  adminId: number
) {
  return withTransaction(async (client) => {
    const current = await lockDriver(client, driverId);
    const changes = diffValues(current, values);
    const { sql, cols } = setClause(changes, allowed, 2);
    if (cols.length === 0) return { changed: [] as string[] };
    try {
      await client.query('SAVEPOINT driver_edit');
      await client.query(
        `UPDATE crm_drivers SET ${sql}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [driverId, ...cols.map((c) => changes[c].to)]
      );
    } catch (err: any) {
      await client.query('ROLLBACK TO SAVEPOINT driver_edit');
      if (err?.code === '23505') throw new DriverEditError('That phone number belongs to another driver', 409);
      throw err;
    }
    await record(client, { driverId, action, changes, adminId });
    return { changed: cols };
  });
}

export function updateDriverDetails(driverId: number, values: Values, adminId: number) {
  return updateDriverColumns(driverId, values, DRIVER_COLUMNS, 'DRIVER_EDIT', adminId);
}

export function updatePayoutDetails(driverId: number, values: Values, adminId: number) {
  return updateDriverColumns(driverId, values, PAYOUT_COLUMNS, 'PAYOUT_DETAILS_EDIT', adminId);
}

/** Adds a vehicle, verified: the admin has entered its document dates, none of which may be past. */
export async function addVehicle(driverId: number, v: Values, adminId: number) {
  return withTransaction(async (client) => {
    await lockDriver(client, driverId);
    const past = await client.query(
      `SELECT $1::date < CURRENT_DATE AS insurance_expiry, $2::date < CURRENT_DATE AS fitness_expiry, $3::date < CURRENT_DATE AS permit_expiry`,
      [v.insurance_expiry, v.fitness_expiry, v.permit_expiry]
    );
    const pastDates = VEHICLE_DATES.filter((f) => past.rows[0][f]);
    if (pastDates.length) throw new DriverEditError(`Cannot add a vehicle with a past date: ${pastDates.join(', ')}`, 422);

    const ins = await client.query(
      `INSERT INTO crm_driver_vehicles (driver_id, wp_vehicle_code, registration_no, model_name,
         insurance_expiry, fitness_expiry, permit_expiry, is_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (registration_no) DO NOTHING
       RETURNING id`,
      [driverId, v.wp_vehicle_code, v.registration_no, v.model_name, v.insurance_expiry, v.fitness_expiry, v.permit_expiry]
    );
    if (ins.rows.length === 0) {
      throw new DriverEditError(`Vehicle ${v.registration_no} is already on file (this or another driver, or removed)`, 409);
    }
    const vehicleId = Number(ins.rows[0].id);
    await record(client, { driverId, vehicleId, action: 'VEHICLE_ADD', changes: diffValues({}, v), adminId });
    return { vehicleId };
  });
}

async function lockVehicle(client: PoolClient, driverId: number, vehicleId: number) {
  const r = await client.query(
    `SELECT id, registration_no, wp_vehicle_code, model_name,
            to_char(insurance_expiry, 'YYYY-MM-DD') AS insurance_expiry,
            to_char(fitness_expiry, 'YYYY-MM-DD') AS fitness_expiry,
            to_char(permit_expiry, 'YYYY-MM-DD') AS permit_expiry
     FROM crm_driver_vehicles WHERE id = $1 AND driver_id = $2 AND removed_at IS NULL FOR UPDATE`,
    [vehicleId, driverId]
  );
  if (r.rows.length === 0) throw new DriverEditError('Vehicle not found for this driver', 404);
  return r.rows[0];
}

/** Changes a vehicle's category, model or dates. A past date is saved; the expiry job then suspends the driver. */
export async function editVehicle(driverId: number, vehicleId: number, v: Values, adminId: number) {
  return withTransaction(async (client) => {
    await lockDriver(client, driverId);
    const current = await lockVehicle(client, driverId, vehicleId);
    const changes = diffValues(current, v);
    const { sql, cols } = setClause(changes, VEHICLE_COLUMNS, 2);
    if (cols.length === 0) return { changed: [] as string[] };
    await client.query(
      `UPDATE crm_driver_vehicles SET ${sql}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [vehicleId, ...cols.map((c) => changes[c].to)]
    );
    await record(client, { driverId, vehicleId, action: 'VEHICLE_EDIT', changes, adminId });
    return { changed: cols };
  });
}

/** Marks a vehicle removed (kept for ride history). Refused while it is on an open ride. */
export async function removeVehicle(driverId: number, vehicleId: number, reason: string, adminId: number) {
  return withTransaction(async (client) => {
    await lockDriver(client, driverId);
    const current = await lockVehicle(client, driverId, vehicleId);
    const open = await client.query(
      `SELECT booking_code FROM crm_bookings
       WHERE assigned_vehicle_id = $1 AND booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS') LIMIT 1`,
      [vehicleId]
    );
    if (open.rows.length) {
      throw new DriverEditError(`Vehicle is on open ride ${open.rows[0].booking_code}; reassign or finish it first`, 409);
    }
    await client.query(
      `UPDATE crm_driver_vehicles SET removed_at = CURRENT_TIMESTAMP, removed_by = $2, removed_reason = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [vehicleId, adminId, reason]
    );
    await record(client, {
      driverId,
      vehicleId,
      action: 'VEHICLE_REMOVE',
      changes: { registration_no: { from: current.registration_no, to: null } },
      reason,
      adminId,
    });
    return { vehicleId };
  });
}

/** Driver details, current vehicles (dates as YYYY-MM-DD) and recent edits, for the edit dialog. */
export async function getDriverEditDetail(driverId: number) {
  const d = await query(
    `SELECT id, full_name, phone, whatsapp_phone, base_city, license_number,
            to_char(license_expiry, 'YYYY-MM-DD') AS license_expiry, bank_upi_id, bank_account_number, bank_ifsc,
            onboarding_status
     FROM crm_drivers WHERE id = $1`,
    [driverId]
  );
  if (d.rows.length === 0) throw new DriverEditError('Driver not found', 404);
  const v = await query(
    `SELECT id, registration_no, wp_vehicle_code, model_name, is_verified,
            to_char(insurance_expiry, 'YYYY-MM-DD') AS insurance_expiry,
            to_char(fitness_expiry, 'YYYY-MM-DD') AS fitness_expiry,
            to_char(permit_expiry, 'YYYY-MM-DD') AS permit_expiry
     FROM crm_driver_vehicles WHERE driver_id = $1 AND removed_at IS NULL ORDER BY id`,
    [driverId]
  );
  const e = await query(
    `SELECT e.id, e.action, e.changes, e.reason, e.created_at, a.full_name AS changed_by_name, v.registration_no
     FROM crm_driver_edits e
     JOIN crm_admin_users a ON a.id = e.changed_by
     LEFT JOIN crm_driver_vehicles v ON v.id = e.vehicle_id
     WHERE e.driver_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
    [driverId]
  );
  // The history is visible to every role that can view drivers, so bank account numbers show only their last 4 digits.
  const edits = e.rows.map((row) => {
    const acc = row.changes?.bank_account_number;
    if (!acc) return row;
    const changes = { ...row.changes, bank_account_number: { from: maskAccount(acc.from), to: maskAccount(acc.to) } };
    return { ...row, changes };
  });
  return { driver: d.rows[0], vehicles: v.rows, edits };
}
