import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { createPaymentLink } from './razorpay';
import { getDriverPlansPolicy, getRevenueProtectionPolicy, getSplitRules } from './settings';
import { gstIncluded, round2, splitFare } from './fare-split';
import { nextDocumentNumber } from './gst-documents';

/**
 * Driver Subscription Plans: prepaid commission balance by ride type (Local, Outstation, Premium).
 * Specification: crm-design/driver_plans_design.md
 *
 * - Drivers pay GST-inclusive price upfront; pre-GST amount becomes their plan balance.
 * - Each ride deducts pre-GST commission + tech fee (GST already paid at plan purchase) + ride's 5% Sec 9(5) GST.
 * - Reserved at ride acceptance, deducted at trip completion, released on cancellation/reassignment.
 * - Zero hardcoded prices or fare limits: all plans are configured dynamically in crm_subscription_plans.
 */

export class PlanError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface SubscriptionPlanRow {
  id: number;
  public_id: string;
  code: string;
  name: string;
  price_incl_gst: number;
  gst_pct: number;
  allowed_trip_types: string[];
  max_fare_limit: number | null;
  priority_rank: number;
  description: string | null;
  is_active: boolean;
}

export interface DriverPlanRow {
  id: number;
  driver_id: number;
  plan_id: number;
  plan_code: string;
  plan_name: string;
  allowed_trip_types: string[];
  max_fare_limit: number | null;
  priority_rank: number;
  status: string;
  amount_paid: number;
  taxable_balance: number;
  gst_amount: number;
  balance_remaining: number;
  reserved_amount: number;
  invoice_number: string | null;
  activated_at: string | null;
  exhausted_at: string | null;
}

/**
 * Amount deducted from a driver's prepaid plan balance for a ride:
 * pre-GST commission + pre-GST tech fee (18% GST was already paid when buying the plan)
 * + 5% ride GST (BiharCabs' Sec 9(5) liability borne by the driver).
 */
export function planDeductionForRide(split: {
  platformCommission: number;
  techFeeAmount: number;
  rideGstAmount: number;
}): number {
  return round2(Number(split.platformCommission || 0) + Number(split.techFeeAmount || 0) + Number(split.rideGstAmount || 0));
}

/** Normalize booking trip type strings into canonical plan trip-type tokens. */
export function normalizePlanTripType(tripType: string): string {
  const t = String(tripType || '').trim().toUpperCase();
  if (t === 'ONEWAY' || t === 'ROUNDTRIP' || t === 'OUTSTATION') return 'OUTSTATION';
  if (t === 'AIRPORT' || t === 'RAILWAY_STATION' || t === 'LOCAL') return 'LOCAL';
  if (t === 'RENTAL') return 'RENTAL';
  return t;
}

export async function minimumPlanPriceForLimit(maxFareLimit: number | null, planGstPct: number): Promise<number> {
  if (!maxFareLimit || maxFareLimit <= 0) return 1;
  const rules = await getSplitRules();
  const split = splitFare(maxFareLimit, rules);
  const minBalance = planDeductionForRide(split);
  return round2(minBalance * (1 + planGstPct / 100));
}

export async function listSubscriptionPlans(opts?: { activeOnly?: boolean }): Promise<SubscriptionPlanRow[]> {
  const sql = opts?.activeOnly
    ? `SELECT * FROM crm_subscription_plans WHERE is_active = true ORDER BY priority_rank DESC, price_incl_gst ASC`
    : `SELECT * FROM crm_subscription_plans ORDER BY priority_rank DESC, price_incl_gst ASC`;
  const res = await query(sql);
  return res.rows.map((r) => ({
    ...r,
    id: Number(r.id),
    price_incl_gst: Number(r.price_incl_gst),
    gst_pct: Number(r.gst_pct),
    max_fare_limit: r.max_fare_limit !== null ? Number(r.max_fare_limit) : null,
    priority_rank: Number(r.priority_rank),
  }));
}

export async function createSubscriptionPlan(input: {
  code: string;
  name: string;
  price_incl_gst: number;
  allowed_trip_types: string[];
  max_fare_limit?: number | null;
  priority_rank?: number;
  description?: string | null;
  is_active?: boolean;
}): Promise<SubscriptionPlanRow> {
  const code = String(input.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const name = String(input.name || '').trim();
  const price = Number(input.price_incl_gst);
  const maxFare = input.max_fare_limit === undefined || input.max_fare_limit === null || String(input.max_fare_limit).trim() === ''
    ? null
    : Number(input.max_fare_limit);
  const priority = Number.isInteger(Number(input.priority_rank)) ? Number(input.priority_rank) : 0;
  const tripTypes = Array.isArray(input.allowed_trip_types)
    ? input.allowed_trip_types.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : [];

  if (!code || !name) throw new PlanError('Plan code and name are required.', 400);
  if (!Number.isFinite(price) || price <= 0) throw new PlanError('Plan price must be a positive amount.', 400);
  if (tripTypes.length === 0) throw new PlanError('At least one allowed trip type is required.', 400);
  if (maxFare !== null && (!Number.isFinite(maxFare) || maxFare <= 0)) {
    throw new PlanError('max_fare_limit must be positive or empty.', 400);
  }

  const policy = await getDriverPlansPolicy();
  const minPrice = await minimumPlanPriceForLimit(maxFare, policy.plan_gst_pct);
  if (price < minPrice) {
    throw new PlanError(
      `Plan price ₹${price.toFixed(2)} is below the minimum ₹${minPrice.toFixed(2)} needed to cover a ₹${maxFare} ride share (including ${policy.plan_gst_pct}% GST).`,
      400
    );
  }

  const res = await query(
    `INSERT INTO crm_subscription_plans (code, name, price_incl_gst, gst_pct, allowed_trip_types, max_fare_limit, priority_rank, description, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [code, name, round2(price), policy.plan_gst_pct, tripTypes, maxFare, priority, input.description || null, input.is_active ?? true]
  );
  const r = res.rows[0];
  return {
    ...r,
    id: Number(r.id),
    price_incl_gst: Number(r.price_incl_gst),
    gst_pct: Number(r.gst_pct),
    max_fare_limit: r.max_fare_limit !== null ? Number(r.max_fare_limit) : null,
    priority_rank: Number(r.priority_rank),
  };
}

export async function updateSubscriptionPlan(
  id: number,
  input: Partial<{
    name: string;
    price_incl_gst: number;
    allowed_trip_types: string[];
    max_fare_limit: number | null;
    priority_rank: number;
    description: string | null;
    is_active: boolean;
  }>
): Promise<SubscriptionPlanRow> {
  const existingRes = await query(`SELECT * FROM crm_subscription_plans WHERE id = $1`, [id]);
  const existing = existingRes.rows[0];
  if (!existing) throw new PlanError('Subscription plan not found.', 404);

  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  const price = input.price_incl_gst !== undefined ? Number(input.price_incl_gst) : Number(existing.price_incl_gst);
  const maxFare = input.max_fare_limit !== undefined
    ? (input.max_fare_limit === null || String(input.max_fare_limit).trim() === '' ? null : Number(input.max_fare_limit))
    : (existing.max_fare_limit !== null ? Number(existing.max_fare_limit) : null);
  const tripTypes = input.allowed_trip_types !== undefined
    ? input.allowed_trip_types.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : existing.allowed_trip_types;
  const priority = input.priority_rank !== undefined ? Number(input.priority_rank) : Number(existing.priority_rank);
  const description = input.description !== undefined ? input.description : existing.description;
  const isActive = input.is_active !== undefined ? Boolean(input.is_active) : Boolean(existing.is_active);

  if (!name || !Number.isFinite(price) || price <= 0 || tripTypes.length === 0) {
    throw new PlanError('Invalid plan fields.', 400);
  }
  const policy = await getDriverPlansPolicy();
  const minPrice = await minimumPlanPriceForLimit(maxFare, policy.plan_gst_pct);
  if (price < minPrice) {
    throw new PlanError(
      `Plan price ₹${price.toFixed(2)} is below the minimum ₹${minPrice.toFixed(2)} needed for max fare ₹${maxFare}.`,
      400
    );
  }

  const res = await query(
    `UPDATE crm_subscription_plans
     SET name = $1, price_incl_gst = $2, gst_pct = $3, allowed_trip_types = $4, max_fare_limit = $5,
         priority_rank = $6, description = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
     WHERE id = $9
     RETURNING *`,
    [name, round2(price), policy.plan_gst_pct, tripTypes, maxFare, priority, description, isActive, id]
  );
  const r = res.rows[0];
  return {
    ...r,
    id: Number(r.id),
    price_incl_gst: Number(r.price_incl_gst),
    gst_pct: Number(r.gst_pct),
    max_fare_limit: r.max_fare_limit !== null ? Number(r.max_fare_limit) : null,
    priority_rank: Number(r.priority_rank),
  };
}

/**
 * Create a Razorpay Payment Link for a driver to purchase / top-up / switch to a subscription plan.
 * Blocked if the driver currently owes unpaid dues (wallet_balance < 0).
 */
export async function requestDriverPlanPaymentLink(
  driverId: number,
  planCode: string
): Promise<{ shortUrl: string; amount: number; planName: string; expireBy: Date }> {
  const dRes = await query(
    `SELECT id, full_name, phone, whatsapp_phone, wallet_balance FROM crm_drivers WHERE id = $1`,
    [driverId]
  );
  const driver = dRes.rows[0];
  if (!driver) throw new PlanError('Driver not found.', 404);
  if (Number(driver.wallet_balance) < 0) {
    throw new PlanError(
      `Clear unpaid dues of ₹${Math.abs(Number(driver.wallet_balance)).toFixed(2)} before purchasing a plan.`,
      409
    );
  }

  const pRes = await query(
    `SELECT * FROM crm_subscription_plans WHERE UPPER(code) = UPPER($1) AND is_active = true`,
    [planCode]
  );
  const plan = pRes.rows[0];
  if (!plan) throw new PlanError(`Subscription plan '${planCode}' is not available.`, 404);

  const amount = round2(Number(plan.price_incl_gst));
  const amountPaise = Math.round(amount * 100);
  const { payment_link_window_minutes } = await getRevenueProtectionPolicy();
  const expireBy = new Date(Date.now() + payment_link_window_minutes * 60 * 1000);
  const referenceId = `PLAN-${driverId}-${crypto.randomBytes(4).toString('hex')}`;
  const contact = String(driver.whatsapp_phone || driver.phone || '').replace(/\D/g, '');

  const pendingRes = await query(
    `INSERT INTO crm_driver_plans (
       driver_id, plan_id, plan_code, plan_name, allowed_trip_types, max_fare_limit,
       priority_rank, status, amount_paid, taxable_balance, gst_amount, balance_remaining, reserved_amount
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_PAYMENT', $8, 0, 0, 0, 0)
     RETURNING id`,
    [
      driverId,
      plan.id,
      plan.code,
      plan.name,
      plan.allowed_trip_types,
      plan.max_fare_limit,
      plan.priority_rank,
      amount,
    ]
  );
  const driverPlanId = Number(pendingRes.rows[0].id);

  try {
    const link = await createPaymentLink({
      amountPaise,
      referenceId,
      description: `BiharCabs ${plan.name} Driver Plan for ${driver.full_name || `#${driverId}`}`,
      expireBy,
      customer: {
        name: driver.full_name || undefined,
        contact: contact.length >= 8 && contact.length <= 14 ? `+${contact}` : undefined,
      },
      notes: { purpose: 'DRIVER_PLAN', driver_id: String(driverId), driver_plan_id: String(driverPlanId) },
    });

    await query(
      `INSERT INTO crm_payment_links (purpose, driver_id, driver_plan_id, provider_link_id, reference_id, amount_paise, currency, short_url, status, expire_by)
       VALUES ('DRIVER_PLAN', $1, $2, $3, $4, $5, 'INR', $6, 'CREATED', $7)`,
      [driverId, driverPlanId, link.id, referenceId, amountPaise, link.shortUrl, expireBy]
    );

    return { shortUrl: link.shortUrl, amount, planName: plan.name, expireBy };
  } catch (err) {
    await query(`UPDATE crm_driver_plans SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [driverPlanId]);
    throw err;
  }
}

/**
 * Activate a driver's subscription plan after Razorpay webhook confirms exact payment.
 * Supports fresh purchase, top-up (same plan code), and upgrade/downgrade (carries over balance & open reservations).
 */
export async function activateDriverPlanFromPayment(
  client: PoolClient,
  driverPlanId: number,
  amountPaid: number,
  paymentRef: string
): Promise<{ activePlanId: number; planName: string; addedBalance: number; newBalance: number; invoiceNumber: string }> {
  const pendingRes = await client.query(
    `SELECT dp.*, sp.gst_pct FROM crm_driver_plans dp
     JOIN crm_subscription_plans sp ON sp.id = dp.plan_id
     WHERE dp.id = $1 FOR UPDATE OF dp`,
    [driverPlanId]
  );
  const pending = pendingRes.rows[0];
  if (!pending) throw new Error(`Driver plan #${driverPlanId} not found.`);

  const driverId = Number(pending.driver_id);
  const gstPct = Number(pending.gst_pct ?? 18);
  const gstAmount = gstIncluded(amountPaid, gstPct);
  const addedBalance = round2(amountPaid - gstAmount);
  const invoiceNumber = await nextDocumentNumber(client, 'TI');

  // Lock any existing live plan for this driver
  const liveRes = await client.query(
    `SELECT * FROM crm_driver_plans WHERE driver_id = $1 AND status IN ('ACTIVE', 'PAUSED') FOR UPDATE`,
    [driverId]
  );
  const live = liveRes.rows[0];

  let activePlanId = driverPlanId;
  let newBalance = addedBalance;

  if (live && live.plan_code === pending.plan_code) {
    // Top-up on the same plan
    activePlanId = Number(live.id);
    newBalance = round2(Number(live.balance_remaining) + addedBalance);
    await client.query(
      `UPDATE crm_driver_plans
       SET amount_paid = amount_paid + $1,
           taxable_balance = taxable_balance + $2,
           gst_amount = gst_amount + $3,
           balance_remaining = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [amountPaid, addedBalance, gstAmount, newBalance, activePlanId]
    );
    await client.query(
      `UPDATE crm_driver_plans SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [driverPlanId]
    );
    await client.query(
      `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, movement_type, amount, balance_after, reserved_after, reference_id, notes)
       VALUES ($1, $2, 'TOPUP', $3, $4, $5, $6, $7)`,
      [activePlanId, driverId, addedBalance, newBalance, Number(live.reserved_amount), paymentRef, `Plan top-up (Invoice ${invoiceNumber}, GST ₹${gstAmount.toFixed(2)})`]
    );
  } else {
    let carryBalance = 0;
    let carryReserved = 0;
    if (live) {
      carryBalance = Number(live.balance_remaining);
      carryReserved = Number(live.reserved_amount);
      await client.query(
        `UPDATE crm_driver_plans
         SET status = 'SUPERSEDED', balance_remaining = 0, reserved_amount = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [live.id]
      );
      if (carryBalance > 0) {
        await client.query(
          `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, movement_type, amount, balance_after, reserved_after, reference_id, notes)
           VALUES ($1, $2, 'CARRY_OVER_OUT', $3, 0, 0, $4, $5)`,
          [live.id, driverId, -carryBalance, paymentRef, `Carried over to ${pending.plan_name}`]
        );
      }
      // Re-point open booking reservations to the new plan
      await client.query(
        `UPDATE crm_bookings SET driver_plan_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE driver_plan_id = $2 AND booking_status IN ('DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS')`,
        [driverPlanId, live.id]
      );
    }

    newBalance = round2(addedBalance + carryBalance);
    const dStatusRes = await client.query(`SELECT onboarding_status FROM crm_drivers WHERE id = $1`, [driverId]);
    const isActiveDriver = dStatusRes.rows[0]?.onboarding_status === 'APPROVED_ACTIVE';
    const nextStatus = isActiveDriver ? 'ACTIVE' : 'PAUSED';

    await client.query(
      `UPDATE crm_driver_plans
       SET status = $1,
           amount_paid = $2,
           taxable_balance = $3,
           gst_amount = $4,
           balance_remaining = $5,
           reserved_amount = $6,
           invoice_number = $7,
           activated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [nextStatus, amountPaid, addedBalance, gstAmount, newBalance, carryReserved, invoiceNumber, driverPlanId]
    );

    if (carryBalance > 0) {
      await client.query(
        `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, movement_type, amount, balance_after, reserved_after, reference_id, notes)
         VALUES ($1, $2, 'CARRY_OVER_IN', $3, $4, $5, $6, $7)`,
        [driverPlanId, driverId, carryBalance, carryBalance, carryReserved, paymentRef, `Carried over from ${live.plan_name}`]
      );
    }

    await client.query(
      `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, movement_type, amount, balance_after, reserved_after, reference_id, notes)
       VALUES ($1, $2, 'PURCHASE', $3, $4, $5, $6, $7)`,
      [driverPlanId, driverId, addedBalance, newBalance, carryReserved, paymentRef, `Plan purchase (Invoice ${invoiceNumber}, GST ₹${gstAmount.toFixed(2)})`]
    );
  }

  await client.query(
    `INSERT INTO crm_payments_ledger (driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
     VALUES ($1, 'DRIVER_PLAN_PURCHASE', 'CREDIT', 'RAZORPAY', $2, $3, $4)`,
    [driverId, amountPaid, paymentRef, `${pending.plan_name} plan purchase; balance ₹${addedBalance.toFixed(2)}, GST ₹${gstAmount.toFixed(2)}, invoice ${invoiceNumber}`]
  );

  return { activePlanId, planName: pending.plan_name, addedBalance, newBalance, invoiceNumber };
}

/**
 * Reserve plan balance when a plan driver accepts or is assigned a ride.
 * Returns true if the booking was bound to the driver's plan; false if it uses commission model.
 */
export async function reservePlanForBookingIfApplicable(
  client: PoolClient,
  driverId: number,
  booking: { id: number; trip_type: string; customer_total_fare: any; platform_commission_amount?: any; tech_fee_amount?: any; ride_gst_amount?: any; commission_amount?: any }
): Promise<{ usedPlan: boolean; driverPlanId: number | null; reserved: number }> {
  const planRes = await client.query(
    `SELECT * FROM crm_driver_plans WHERE driver_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [driverId]
  );
  const plan = planRes.rows[0];
  if (!plan) return { usedPlan: false, driverPlanId: null, reserved: 0 };

  const normType = normalizePlanTripType(booking.trip_type);
  const allowed: string[] = Array.isArray(plan.allowed_trip_types) ? plan.allowed_trip_types.map((t: string) => t.toUpperCase()) : [];
  if (!allowed.includes(normType) && !allowed.includes('ALL')) {
    return { usedPlan: false, driverPlanId: null, reserved: 0 };
  }

  const fare = Number(booking.customer_total_fare || 0);
  if (plan.max_fare_limit !== null && fare > Number(plan.max_fare_limit)) {
    return { usedPlan: false, driverPlanId: null, reserved: 0 };
  }

  const deduction = booking.platform_commission_amount !== undefined && booking.platform_commission_amount !== null
    ? planDeductionForRide({
        platformCommission: Number(booking.platform_commission_amount || 0),
        techFeeAmount: Number(booking.tech_fee_amount || 0),
        rideGstAmount: Number(booking.ride_gst_amount || 0),
      })
    : round2(Number(booking.commission_amount || 0));

  const freeBalance = round2(Number(plan.balance_remaining) - Number(plan.reserved_amount));
  if (freeBalance < deduction) {
    return { usedPlan: false, driverPlanId: null, reserved: 0 };
  }

  const newReserved = round2(Number(plan.reserved_amount) + deduction);
  await client.query(
    `UPDATE crm_driver_plans SET reserved_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [newReserved, plan.id]
  );
  await client.query(
    `UPDATE crm_bookings
     SET billing_model = 'PLAN', driver_plan_id = $1, plan_amount_reserved = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [plan.id, deduction, booking.id]
  );
  await client.query(
    `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, booking_id, movement_type, amount, balance_after, reserved_after, notes)
     VALUES ($1, $2, $3, 'RESERVE', $4, $5, $6, 'Reserved at ride assignment')`,
    [plan.id, driverId, booking.id, deduction, Number(plan.balance_remaining), newReserved]
  );

  return { usedPlan: true, driverPlanId: Number(plan.id), reserved: deduction };
}

/** Release any plan reservation when a booking is cancelled or reassigned. */
export async function releasePlanReservation(client: PoolClient, bookingId: number, reason: string): Promise<void> {
  const bRes = await client.query(
    `SELECT billing_model, driver_plan_id, plan_amount_reserved, assigned_driver_id FROM crm_bookings WHERE id = $1`,
    [bookingId]
  );
  const b = bRes.rows[0];
  if (!b || b.billing_model !== 'PLAN' || !b.driver_plan_id || Number(b.plan_amount_reserved) <= 0) return;

  const reserved = Number(b.plan_amount_reserved);
  const pRes = await client.query(`SELECT * FROM crm_driver_plans WHERE id = $1 FOR UPDATE`, [b.driver_plan_id]);
  const plan = pRes.rows[0];
  if (!plan) return;

  const newReserved = round2(Math.max(0, Number(plan.reserved_amount) - reserved));
  await client.query(
    `UPDATE crm_driver_plans SET reserved_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [newReserved, plan.id]
  );
  await client.query(
    `UPDATE crm_bookings SET billing_model = 'COMMISSION', driver_plan_id = NULL, plan_amount_reserved = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [bookingId]
  );
  await client.query(
    `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, booking_id, movement_type, amount, balance_after, reserved_after, notes)
     VALUES ($1, $2, $3, 'RELEASE', $4, $5, $6, $7)`,
    [plan.id, plan.driver_id, bookingId, -reserved, Number(plan.balance_remaining), newReserved, reason]
  );
}

/**
 * Deduct BiharCabs' share from the driver's prepaid plan at trip completion.
 * Any overflow (e.g. from extra hours/km exceeding remaining balance) is returned as walletOverflow
 * so billing.ts debits the driver's wallet cleanly without letting plan balance go negative.
 */
export async function deductPlanOnTripCompletion(
  client: PoolClient,
  bookingId: number,
  driverPlanId: number,
  reservedAmount: number,
  actualDeduction: number
): Promise<{ deductedFromPlan: number; walletOverflow: number; newPlanBalance: number; exhausted: boolean }> {
  const pRes = await client.query(`SELECT * FROM crm_driver_plans WHERE id = $1 FOR UPDATE`, [driverPlanId]);
  const plan = pRes.rows[0];
  if (!plan) {
    return { deductedFromPlan: 0, walletOverflow: actualDeduction, newPlanBalance: 0, exhausted: false };
  }

  const currentBal = Number(plan.balance_remaining);
  const newReserved = round2(Math.max(0, Number(plan.reserved_amount) - Number(reservedAmount || 0)));
  const deductedFromPlan = round2(Math.min(currentBal, actualDeduction));
  const walletOverflow = round2(Math.max(0, actualDeduction - deductedFromPlan));
  const newBalance = round2(currentBal - deductedFromPlan);
  const exhausted = newBalance <= 0;

  await client.query(
    `UPDATE crm_driver_plans
     SET balance_remaining = $1,
         reserved_amount = $2,
         status = CASE WHEN $3 THEN 'EXHAUSTED' ELSE status END,
         exhausted_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE exhausted_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [newBalance, newReserved, exhausted, plan.id]
  );

  await client.query(
    `INSERT INTO crm_driver_plan_movements (driver_plan_id, driver_id, booking_id, movement_type, amount, balance_after, reserved_after, notes)
     VALUES ($1, $2, $3, 'DEDUCT', $4, $5, $6, $7)`,
    [
      plan.id,
      plan.driver_id,
      bookingId,
      -deductedFromPlan,
      newBalance,
      newReserved,
      walletOverflow > 0
        ? `Trip deduction (₹${deductedFromPlan.toFixed(2)} from plan, ₹${walletOverflow.toFixed(2)} overflow to wallet)`
        : 'Trip completion commission & ride GST deduction',
    ]
  );

  await client.query(`UPDATE crm_bookings SET plan_amount_reserved = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [bookingId]);

  return { deductedFromPlan, walletOverflow, newPlanBalance: newBalance, exhausted };
}

/** Pause a driver's plan on suspension, or resume it on reactivation. */
export async function syncDriverPlanSuspension(driverId: number, isActiveDriver: boolean): Promise<void> {
  if (isActiveDriver) {
    await query(
      `UPDATE crm_driver_plans SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
       WHERE driver_id = $1 AND status = 'PAUSED' AND balance_remaining > 0`,
      [driverId]
    );
  } else {
    await query(
      `UPDATE crm_driver_plans SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP
       WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [driverId]
    );
  }
}

export async function getDriverPlanSummary(driverId: number): Promise<{ activePlan: DriverPlanRow | null; movements: any[] }> {
  const pRes = await query(
    `SELECT * FROM crm_driver_plans WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [driverId]
  );
  const activePlan = pRes.rows[0]
    ? {
        ...pRes.rows[0],
        id: Number(pRes.rows[0].id),
        driver_id: Number(pRes.rows[0].driver_id),
        plan_id: Number(pRes.rows[0].plan_id),
        amount_paid: Number(pRes.rows[0].amount_paid),
        taxable_balance: Number(pRes.rows[0].taxable_balance),
        gst_amount: Number(pRes.rows[0].gst_amount),
        balance_remaining: Number(pRes.rows[0].balance_remaining),
        reserved_amount: Number(pRes.rows[0].reserved_amount),
      }
    : null;
  const mRes = await query(
    `SELECT * FROM crm_driver_plan_movements WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [driverId]
  );
  return { activePlan, movements: mRes.rows };
}
