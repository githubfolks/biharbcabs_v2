import { query, withTransaction } from './db';
import { sendWhatsAppText } from './whatsapp';

/**
 * Money BiharCabs pays out to drivers. A positive wallet_balance is what BiharCabs owes the driver;
 * recording a payout lowers it and writes a DRIVER_PAYOUT_SENT ledger entry with the reference.
 * BiharCabs never records paying more than it owes, and a reference is recorded only once.
 */

export const PAYOUT_CHANNELS = ['UPI', 'BANK_TRANSFER', 'CASH'] as const;
export type PayoutChannel = (typeof PAYOUT_CHANNELS)[number];
const MIN_REFERENCE_LENGTH = 6;
const MAX_REFERENCE_LENGTH = 100;

export class PayoutError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface RecordPayoutInput {
  driverId: number;
  amount: number;
  channel: string;
  reference: string;
  notes?: string;
  adminId: number;
}

export interface RecordPayoutResult {
  driverId: number;
  amount: number;
  newWalletBalance: number;
}

export async function recordDriverPayout(input: RecordPayoutInput): Promise<RecordPayoutResult> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
    throw new PayoutError('Amount must be a positive rupee amount with at most 2 decimals.', 400);
  }
  if (!PAYOUT_CHANNELS.includes(input.channel as PayoutChannel)) {
    throw new PayoutError(`Channel must be one of: ${PAYOUT_CHANNELS.join(', ')}.`, 400);
  }
  const reference = String(input.reference || '').trim();
  if (reference.length < MIN_REFERENCE_LENGTH || reference.length > MAX_REFERENCE_LENGTH) {
    throw new PayoutError(
      input.channel === 'CASH'
        ? `Cash payouts need a receipt number of ${MIN_REFERENCE_LENGTH} to ${MAX_REFERENCE_LENGTH} characters.`
        : `The ${input.channel} transaction reference must be ${MIN_REFERENCE_LENGTH} to ${MAX_REFERENCE_LENGTH} characters.`,
      400
    );
  }
  const notes = String(input.notes || '').trim().slice(0, 500);

  let driver: { full_name: string; phone: string; whatsapp_phone: string | null };
  let newWalletBalance: number;
  try {
    ({ driver, newWalletBalance } = await withTransaction(async (client) => {
      const dRes = await client.query(
        `SELECT id, full_name, phone, whatsapp_phone, wallet_balance FROM crm_drivers WHERE id = $1 FOR UPDATE`,
        [input.driverId]
      );
      const d = dRes.rows[0];
      if (!d) throw new PayoutError('Driver not found.', 404);

      const owed = Number(d.wallet_balance);
      if (amount > owed) {
        throw new PayoutError(
          owed > 0 ? `BiharCabs owes this driver ₹${owed.toFixed(2)}; a payout cannot exceed that.` : 'BiharCabs owes this driver nothing.',
          400
        );
      }
      const balance = parseFloat((owed - amount).toFixed(2));

      await client.query(
        `INSERT INTO crm_payments_ledger (driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes, recorded_by)
         VALUES ($1, 'DRIVER_PAYOUT_SENT', 'DEBIT', $2, $3, $4, $5, $6)`,
        [input.driverId, input.channel, amount, reference, notes || `Payout via ${input.channel}`, input.adminId]
      );
      await client.query(
        `UPDATE crm_drivers SET wallet_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [balance, input.driverId]
      );
      return { driver: d, newWalletBalance: balance };
    }));
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new PayoutError(`A ${input.channel} payout with reference ${reference} is already recorded.`, 409);
    }
    throw err;
  }

  console.info(`[Payouts] ₹${amount.toFixed(2)} to driver #${input.driverId} via ${input.channel} recorded by admin #${input.adminId}`);
  const phone = driver.whatsapp_phone || driver.phone;
  if (phone) {
    try {
      await sendWhatsAppText(
        phone,
        `💸 BiharCabs paid you ₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} by ${input.channel.replace('_', ' ')} (ref ${reference}).\nAmount still owed to you: ₹${newWalletBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      );
    } catch (err: any) {
      console.error(`[Payouts] Driver notification failed for driver #${input.driverId}:`, err?.message);
    }
  }

  return { driverId: input.driverId, amount, newWalletBalance };
}

/** Drivers BiharCabs currently owes money to, largest first. */
export async function listDriversOwed() {
  const res = await query(
    `SELECT d.id, d.full_name, d.phone, d.wallet_balance,
            (SELECT MAX(l.created_at) FROM crm_payments_ledger l
             WHERE l.driver_id = d.id AND l.transaction_type = 'DRIVER_PAYOUT_SENT') AS last_payout_at
     FROM crm_drivers d
     WHERE d.wallet_balance > 0
     ORDER BY d.wallet_balance DESC`
  );
  return res.rows.map((r) => ({ ...r, wallet_balance: Number(r.wallet_balance) }));
}
