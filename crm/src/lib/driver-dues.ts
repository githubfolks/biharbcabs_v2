import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { createPaymentLink } from './razorpay';
import { getRevenueProtectionPolicy, RevenueProtectionPolicyConfig } from './settings';

/**
 * Money a driver pays BiharCabs toward their dues (a negative wallet_balance). A payment writes a
 * DRIVER_DUES_PAYMENT ledger entry and raises the wallet in one transaction, locked on the driver row.
 * If the driver is then back within their credit limit, a dues restriction is lifted.
 *
 * Two sources:
 * - RAZORPAY: the driver pays a link from the bot's "Pay dues" button; only the signed webhook records it.
 * - Manual: finance records UPI to the company VPA, a bank transfer or cash, with its reference.
 */

export const DUES_CHANNELS = ['UPI', 'BANK_TRANSFER', 'CASH'] as const;
const MIN_REFERENCE_LENGTH = 6;
const MAX_REFERENCE_LENGTH = 100;
/** Statuses set because of unpaid dues; other suspensions (documents, ratings) are never lifted here. */
const DUES_STATUSES = ['RESTRICTED_DIGITAL_ONLY', 'SUSPENDED_UNPAID_DUES'];

export class DuesError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The driver's credit limit by tier; the same rule the dues guardrail uses to restrict them. */
export function creditLimitFor(driver: { rating: any; total_trips_completed: any }, policy: RevenueProtectionPolicyConfig): number {
  const rating = Number(driver.rating);
  const trips = Number(driver.total_trips_completed || 0);
  if (rating >= policy.elite_min_rating && trips >= policy.elite_min_trips) return policy.dynamic_credit_limits.elite;
  if (rating >= policy.standard_min_rating) return policy.dynamic_credit_limits.standard;
  return policy.dynamic_credit_limits.probation_or_new;
}

export interface DuesPaymentResult {
  driverId: number;
  amount: number;
  newWalletBalance: number;
  restored: boolean;
}

/**
 * Record a dues payment inside the caller's transaction. A manual entry may not exceed what is owed;
 * a Razorpay payment is money already received, so it is recorded in full (any excess is then owed
 * to the driver and shows up for payout).
 */
export async function applyDuesPayment(
  client: PoolClient,
  input: { driverId: number; amount: number; channel: string; reference: string; notes: string; adminId: number | null; source: 'RAZORPAY' | 'MANUAL' }
): Promise<DuesPaymentResult> {
  const dRes = await client.query(
    `SELECT id, wallet_balance, rating, total_trips_completed, onboarding_status FROM crm_drivers WHERE id = $1 FOR UPDATE`,
    [input.driverId]
  );
  const d = dRes.rows[0];
  if (!d) throw new DuesError('Driver not found.', 404);
  const owed = -Number(d.wallet_balance);
  if (input.source === 'MANUAL') {
    if (owed <= 0) throw new DuesError('This driver owes BiharCabs nothing.', 400);
    if (input.amount > owed) throw new DuesError(`This driver owes ₹${owed.toFixed(2)}; a payment cannot exceed that.`, 400);
  }

  const newWallet = parseFloat((Number(d.wallet_balance) + input.amount).toFixed(2));
  const policy = await getRevenueProtectionPolicy();
  const restored = DUES_STATUSES.includes(d.onboarding_status) && newWallet >= -creditLimitFor(d, policy);

  try {
    await client.query('SAVEPOINT dues_ledger');
    await client.query(
      `INSERT INTO crm_payments_ledger (driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes, recorded_by)
       VALUES ($1, 'DRIVER_DUES_PAYMENT', 'CREDIT', $2, $3, $4, $5, $6)`,
      [input.driverId, input.channel, input.amount, input.reference, input.notes, input.adminId]
    );
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT dues_ledger');
    if (err?.code === '23505') throw new DuesError(`A ${input.channel} payment with reference ${input.reference} is already recorded.`, 409);
    throw err;
  }
  await client.query(
    `UPDATE crm_drivers
     SET wallet_balance = $1,
         onboarding_status = CASE WHEN $2 THEN 'APPROVED_ACTIVE' ELSE onboarding_status END,
         is_available = CASE WHEN $2 THEN true ELSE is_available END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [newWallet, restored, input.driverId]
  );
  return { driverId: input.driverId, amount: input.amount, newWalletBalance: newWallet, restored };
}

/** Finance records a dues payment received outside Razorpay (UPI to the company VPA, bank, cash). */
export async function recordManualDuesPayment(input: {
  driverId: number;
  amount: number;
  channel: string;
  reference: string;
  notes?: string;
  adminId: number;
}): Promise<DuesPaymentResult> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
    throw new DuesError('Amount must be a positive rupee amount with at most 2 decimals.', 400);
  }
  if (!DUES_CHANNELS.includes(input.channel as any)) {
    throw new DuesError(`Channel must be one of: ${DUES_CHANNELS.join(', ')}.`, 400);
  }
  const reference = String(input.reference || '').trim();
  if (reference.length < MIN_REFERENCE_LENGTH || reference.length > MAX_REFERENCE_LENGTH) {
    throw new DuesError(
      input.channel === 'CASH'
        ? `Cash payments need a receipt number of ${MIN_REFERENCE_LENGTH} to ${MAX_REFERENCE_LENGTH} characters.`
        : `The ${input.channel} transaction reference must be ${MIN_REFERENCE_LENGTH} to ${MAX_REFERENCE_LENGTH} characters.`,
      400
    );
  }
  const notes = String(input.notes || '').trim().slice(0, 500) || `Dues paid via ${input.channel}`;
  const result = await withTransaction((client) =>
    applyDuesPayment(client, { driverId: input.driverId, amount, channel: input.channel, reference, notes, adminId: input.adminId, source: 'MANUAL' })
  );
  console.info(`[Dues] ₹${amount.toFixed(2)} from driver #${input.driverId} via ${input.channel} recorded by admin #${input.adminId}`);
  return result;
}

/**
 * A Razorpay link for what the driver owes now. An unexpired link for the same amount is reused, so
 * tapping "Pay dues" twice does not open two links. Returns null when nothing is owed.
 */
export async function requestDuesPaymentLink(driverId: number): Promise<{ shortUrl: string; amount: number; expireBy: Date } | null> {
  const dRes = await query(`SELECT id, full_name, phone, whatsapp_phone, wallet_balance FROM crm_drivers WHERE id = $1`, [driverId]);
  const d = dRes.rows[0];
  if (!d) throw new DuesError('Driver not found.', 404);
  const owed = parseFloat((-Number(d.wallet_balance)).toFixed(2));
  if (owed <= 0) return null;
  const amountPaise = Math.round(owed * 100);
  if (amountPaise < 100) throw new DuesError('Dues below ₹1 cannot be paid online.', 400);

  const open = await query(
    `SELECT short_url, expire_by FROM crm_payment_links
     WHERE purpose = 'DRIVER_DUES' AND driver_id = $1 AND status = 'CREATED' AND amount_paise = $2
       AND expire_by > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
     ORDER BY id DESC LIMIT 1`,
    [driverId, amountPaise]
  );
  if (open.rows[0]) return { shortUrl: open.rows[0].short_url, amount: owed, expireBy: new Date(open.rows[0].expire_by) };

  const { payment_link_window_minutes } = await getRevenueProtectionPolicy();
  const expireBy = new Date(Date.now() + payment_link_window_minutes * 60 * 1000);
  const referenceId = `DUES-${driverId}-${crypto.randomBytes(4).toString('hex')}`;
  const contact = String(d.whatsapp_phone || d.phone || '').replace(/\D/g, '');
  const link = await createPaymentLink({
    amountPaise,
    referenceId,
    description: `BiharCabs dues payment for driver ${d.full_name || `#${driverId}`}`,
    expireBy,
    customer: { name: d.full_name || undefined, contact: contact.length >= 8 && contact.length <= 14 ? `+${contact}` : undefined },
    notes: { purpose: 'DRIVER_DUES', driver_id: String(driverId) },
  });
  await query(
    `INSERT INTO crm_payment_links (purpose, driver_id, provider_link_id, reference_id, amount_paise, currency, short_url, status, expire_by)
     VALUES ('DRIVER_DUES', $1, $2, $3, $4, 'INR', $5, 'CREATED', $6)`,
    [driverId, link.id, referenceId, amountPaise, link.shortUrl, expireBy]
  );
  return { shortUrl: link.shortUrl, amount: owed, expireBy };
}

/** Drivers who owe BiharCabs money, largest first, with their credit limit and status. */
export async function listDriversOwing() {
  const policy = await getRevenueProtectionPolicy();
  const res = await query(
    `SELECT d.id, d.full_name, d.phone, d.wallet_balance, d.rating, d.total_trips_completed, d.onboarding_status,
            (SELECT MAX(l.created_at) FROM crm_payments_ledger l
             WHERE l.driver_id = d.id AND l.transaction_type = 'DRIVER_DUES_PAYMENT') AS last_payment_at
     FROM crm_drivers d
     WHERE d.wallet_balance < 0
     ORDER BY d.wallet_balance ASC`
  );
  return res.rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    phone: r.phone,
    owed: -Number(r.wallet_balance),
    credit_limit: creditLimitFor(r, policy),
    onboarding_status: r.onboarding_status,
    last_payment_at: r.last_payment_at,
  }));
}
