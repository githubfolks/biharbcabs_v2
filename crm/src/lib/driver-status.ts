import { DomainError } from './route-errors';
/**
 * Manual driver status changes by staff (migration 30): activate, suspend, offboard.
 * Allowed changes are in driver-status-rules.ts. Each change needs a reason and is recorded in
 * crm_driver_status_changes with the admin who made it, in the same transaction as the change.
 */
import { query, withTransaction } from './db';
import { isIsoDate } from './driver-onboarding';
import { syncDriverPlanSuspension } from './driver-plans';
import {
  ACTION_TARGET,
  DRIVER_STATUS_ACTIONS,
  DriverStatusAction,
  isActionAllowed,
  REASON_MAX,
  REASON_MIN,
} from './driver-status-rules';

export class DriverStatusError extends DomainError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export interface VehicleDates {
  id: number;
  insurance_expiry: string;
  fitness_expiry: string;
  permit_expiry: string;
}

export interface StatusChangeRequest {
  action: DriverStatusAction;
  reason: string;
  /** Only for ACTIVATE: document dates the admin checked, saved before the activation check. */
  license_expiry?: string;
  vehicles?: VehicleDates[];
}

/** Checks the request body. Pure, so it can be tested without a database. */
export function parseStatusChange(body: any): { ok: true; change: StatusChangeRequest } | { ok: false; error: string } {
  const action = body?.action;
  if (!DRIVER_STATUS_ACTIONS.includes(action)) {
    return { ok: false, error: `action must be one of ${DRIVER_STATUS_ACTIONS.join(', ')}` };
  }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return { ok: false, error: `reason must be ${REASON_MIN}-${REASON_MAX} characters` };
  }
  const change: StatusChangeRequest = { action, reason };
  if (action !== 'ACTIVATE') return { ok: true, change };

  if (body.license_expiry !== undefined && body.license_expiry !== null) {
    if (!isIsoDate(body.license_expiry)) return { ok: false, error: 'license_expiry must be a date (YYYY-MM-DD)' };
    change.license_expiry = body.license_expiry;
  }
  if (body.vehicles !== undefined && body.vehicles !== null) {
    if (!Array.isArray(body.vehicles)) return { ok: false, error: 'vehicles must be a list' };
    const vehicles: VehicleDates[] = [];
    for (const v of body.vehicles) {
      const id = Number(v?.id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'each vehicle needs a valid id' };
      for (const f of ['insurance_expiry', 'fitness_expiry', 'permit_expiry'] as const) {
        if (!isIsoDate(v[f])) return { ok: false, error: `vehicle ${id}: ${f} must be a date (YYYY-MM-DD)` };
      }
      vehicles.push({ id, insurance_expiry: v.insurance_expiry, fitness_expiry: v.fitness_expiry, permit_expiry: v.permit_expiry });
    }
    change.vehicles = vehicles;
  }
  return { ok: true, change };
}

const DUES_STATUSES = ['RESTRICTED_DIGITAL_ONLY', 'SUSPENDED_UNPAID_DUES'];

export async function changeDriverStatus(driverId: number, change: StatusChangeRequest, adminId: number) {
  return withTransaction(async (client) => {
    const dRes = await client.query(`SELECT id, onboarding_status FROM crm_drivers WHERE id = $1 FOR UPDATE`, [driverId]);
    if (dRes.rows.length === 0) throw new DriverStatusError('Driver not found', 404);
    const fromStatus: string = dRes.rows[0].onboarding_status;
    const toStatus = ACTION_TARGET[change.action];

    if (!isActionAllowed(change.action, fromStatus)) {
      const hint =
        change.action === 'ACTIVATE' && DUES_STATUSES.includes(fromStatus)
          ? ' The driver is restricted for unpaid dues; the account is restored when the dues are paid (Finance).'
          : '';
      throw new DriverStatusError(`Cannot ${change.action.toLowerCase()} a driver who is ${fromStatus}.${hint}`, 409);
    }

    if (change.action === 'ACTIVATE') {
      if (change.license_expiry) {
        await client.query(`UPDATE crm_drivers SET license_expiry = $1 WHERE id = $2`, [change.license_expiry, driverId]);
      }
      for (const v of change.vehicles || []) {
        const u = await client.query(
          `UPDATE crm_driver_vehicles
           SET insurance_expiry = $1, fitness_expiry = $2, permit_expiry = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND driver_id = $5 AND removed_at IS NULL`,
          [v.insurance_expiry, v.fitness_expiry, v.permit_expiry, v.id, driverId]
        );
        if (u.rowCount === 0) throw new DriverStatusError(`Vehicle ${v.id} is not a current vehicle of this driver`, 400);
      }

      // Same date rules as dispatch and the expiry job, but a missing date also blocks activation.
      const docs = await client.query(
        `SELECT (d.license_expiry IS NOT NULL AND d.license_expiry >= CURRENT_DATE) AS licence_ok,
                v.registration_no,
                (v.insurance_expiry IS NOT NULL AND v.insurance_expiry >= CURRENT_DATE) AS insurance_ok,
                (v.fitness_expiry IS NOT NULL AND v.fitness_expiry >= CURRENT_DATE) AS fitness_ok,
                (v.permit_expiry IS NOT NULL AND v.permit_expiry >= CURRENT_DATE) AS permit_ok
         FROM crm_drivers d LEFT JOIN crm_driver_vehicles v ON v.driver_id = d.id AND v.removed_at IS NULL
         WHERE d.id = $1
         ORDER BY v.id`,
        [driverId]
      );
      const problems: string[] = [];
      if (!docs.rows[0].licence_ok) problems.push('licence expiry is missing or past');
      const vehicles = docs.rows.filter((r) => r.registration_no);
      if (vehicles.length === 0) problems.push('driver has no vehicle');
      for (const r of vehicles) {
        for (const [ok, label] of [[r.insurance_ok, 'insurance'], [r.fitness_ok, 'fitness'], [r.permit_ok, 'permit']] as const) {
          if (!ok) problems.push(`${r.registration_no} ${label} expiry is missing or past`);
        }
      }
      if (problems.length > 0) throw new DriverStatusError(`Cannot activate: ${problems.join('; ')}`, 422);

      // Activation is the admin's verification of the documents.
      await client.query(
        `UPDATE crm_driver_vehicles SET is_verified = true, updated_at = CURRENT_TIMESTAMP WHERE driver_id = $1 AND removed_at IS NULL`,
        [driverId]
      );
    }

    await client.query(
      `UPDATE crm_drivers SET onboarding_status = $1, is_available = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [toStatus, change.action === 'ACTIVATE', driverId]
    );
    await client.query(
      `INSERT INTO crm_driver_status_changes (driver_id, action, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [driverId, change.action, fromStatus, toStatus, change.reason, adminId]
    );
    return { driverId, fromStatus, toStatus };
  }).then(async (res) => {
    await syncDriverPlanSuspension(driverId, change.action === 'ACTIVATE');
    return res;
  });
}

/** Current status, document dates (as YYYY-MM-DD) and status history for the status dialog. */
export async function getDriverStatusDetail(driverId: number) {
  const dRes = await query(
    `SELECT d.id, d.onboarding_status, to_char(d.license_expiry, 'YYYY-MM-DD') AS license_expiry,
            d.offers_paused, d.offers_paused_reason, d.offers_paused_at, a.full_name AS offers_paused_by_name
     FROM crm_drivers d LEFT JOIN crm_admin_users a ON a.id = d.offers_paused_by
     WHERE d.id = $1`,
    [driverId]
  );
  if (dRes.rows.length === 0) throw new DriverStatusError('Driver not found', 404);
  const vRes = await query(
    `SELECT id, registration_no, model_name, wp_vehicle_code, is_verified,
            to_char(insurance_expiry, 'YYYY-MM-DD') AS insurance_expiry,
            to_char(fitness_expiry, 'YYYY-MM-DD') AS fitness_expiry,
            to_char(permit_expiry, 'YYYY-MM-DD') AS permit_expiry
     FROM crm_driver_vehicles WHERE driver_id = $1 AND removed_at IS NULL ORDER BY id`,
    [driverId]
  );
  const hRes = await query(
    `SELECT c.id, c.action, c.from_status, c.to_status, c.reason, c.created_at, a.full_name AS changed_by_name
     FROM crm_driver_status_changes c JOIN crm_admin_users a ON a.id = c.changed_by
     WHERE c.driver_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 50`,
    [driverId]
  );
  return {
    status: dRes.rows[0].onboarding_status as string,
    license_expiry: dRes.rows[0].license_expiry as string | null,
    offers: {
      paused: dRes.rows[0].offers_paused as boolean,
      reason: dRes.rows[0].offers_paused_reason as string | null,
      at: dRes.rows[0].offers_paused_at,
      by: dRes.rows[0].offers_paused_by_name as string | null,
    },
    vehicles: vRes.rows,
    history: hRes.rows,
  };
}
