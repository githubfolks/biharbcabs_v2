import { DomainError } from './route-errors';
/**
 * A driver's wallet: current balances and the ledger entries recorded against them, newest first.
 *
 * The entries are shown as recorded and are not added up into a running balance, because they do not
 * reconcile line by line: a trip settlement records the net amount (already including any reserve
 * deduction and streak bonus) and also records those two as their own entries, and cash a driver
 * collects from the customer is recorded although it does not move the wallet.
 */
import { query } from './db';

export class DriverWalletError extends DomainError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export async function getDriverWallet(driverId: number, limit = 100) {
  const d = await query(
    `SELECT id, full_name, wallet_balance, security_reserve_balance FROM crm_drivers WHERE id = $1`,
    [driverId]
  );
  if (d.rows.length === 0) throw new DriverWalletError('Driver not found', 404);
  const entries = await query(
    `SELECT l.id, l.created_at, l.transaction_type, l.direction, l.payment_channel, l.amount, l.reference_id, l.notes,
            b.booking_code, a.full_name AS recorded_by_name
     FROM crm_payments_ledger l
     LEFT JOIN crm_bookings b ON b.id = l.booking_id
     LEFT JOIN crm_admin_users a ON a.id = l.recorded_by
     WHERE l.driver_id = $1
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $2`,
    [driverId, limit]
  );
  const total = await query(`SELECT COUNT(*)::int AS n FROM crm_payments_ledger WHERE driver_id = $1`, [driverId]);
  return {
    driver: {
      id: Number(d.rows[0].id),
      full_name: d.rows[0].full_name,
      wallet_balance: Number(d.rows[0].wallet_balance),
      security_reserve_balance: Number(d.rows[0].security_reserve_balance || 0),
    },
    entries: entries.rows.map((e) => ({ ...e, amount: Number(e.amount) })),
    totalEntries: total.rows[0].n as number,
  };
}
