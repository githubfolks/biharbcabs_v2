import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { cancelPaymentLink, createPaymentLink, fetchPaymentLinkStatus } from './razorpay';
import { AdvanceCollectionPolicy, getAdvanceCollectionPolicy, getCompanyBillingInfo, getRevenueProtectionPolicy } from './settings';
import { gstIncluded } from './fare-split';
import { bookingPickupAt, broadcastRideToDrivers } from './dispatch-engine';
import { notifyOfferedDrivers } from './dispatch-notify';
import { sendWhatsAppText } from './whatsapp';
import { notify, notifyAdmins } from './wa-notify';
import { MIN_WAIVER_REASON_LENGTH, WAIVABLE_STATUSES } from './advance-rules';
import { applyDuesPayment } from './driver-dues';
import { markRefundProcessed } from './refunds';

/**
 * Customer advance: which rides need it online, the Razorpay link for it, and the webhook that
 * confirms it. A booking that needs the advance waits in AWAITING_ADVANCE and reaches drivers
 * only after Razorpay's signed webhook confirms the exact amount was captured.
 */

export type PaymentMode = 'ADVANCE_ONLINE' | 'FULL_CASH';

export function isAdvanceRequired(policy: AdvanceCollectionPolicy, tripType: string, fare: number): boolean {
  if (policy.required_trip_types.includes(String(tripType || '').toLowerCase())) return true;
  return policy.required_above_fare !== null && fare >= policy.required_above_fare;
}

export interface AdvanceRequestResult {
  shortUrl: string;
  amount: number;
  expireBy: Date;
}

/**
 * Create the Razorpay link for a booking waiting on its advance. If Razorpay fails, the booking is
 * marked ADVANCE_LINK_FAILED (so staff can see it) and the error is thrown; it never reaches drivers.
 */
export async function requestAdvancePayment(bookingId: number): Promise<AdvanceRequestResult> {
  const res = await query(
    `SELECT b.id, b.booking_code, b.booking_status, b.advance_due_amount, b.origin_city, b.destination_city,
            c.full_name AS customer_name, c.phone AS customer_phone
     FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const b = res.rows[0];
  if (!b) throw new Error(`Booking #${bookingId} not found.`);
  if (b.booking_status !== 'AWAITING_ADVANCE') {
    throw new Error(`Booking ${b.booking_code} is not waiting for an advance (status ${b.booking_status}).`);
  }
  const amount = Number(b.advance_due_amount);
  const amountPaise = Math.round(amount * 100);

  const policy = await getAdvanceCollectionPolicy();
  const expireBy = new Date(Date.now() + policy.payment_window_minutes * 60 * 1000);
  const referenceId = `${b.booking_code}-${crypto.randomBytes(4).toString('hex')}`;
  const contact = String(b.customer_phone || '').replace(/\D/g, '');

  let link;
  try {
    link = await createPaymentLink({
      amountPaise,
      referenceId,
      description: `BiharCabs advance for booking ${b.booking_code} (${b.origin_city} to ${b.destination_city || 'local'})`,
      expireBy,
      customer: {
        name: b.customer_name || undefined,
        contact: contact.length >= 8 && contact.length <= 14 ? `+${contact}` : undefined,
      },
      notes: { booking_code: String(b.booking_code) },
    });
  } catch (err) {
    await query(
      `UPDATE crm_bookings SET booking_status = 'ADVANCE_LINK_FAILED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND booking_status = 'AWAITING_ADVANCE'`,
      [bookingId]
    );
    throw err;
  }

  await query(
    `INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, currency, short_url, status, expire_by)
     VALUES ($1, $2, $3, $4, 'INR', $5, 'CREATED', $6)`,
    [bookingId, link.id, referenceId, amountPaise, link.shortUrl, expireBy]
  );

  return { shortUrl: link.shortUrl, amount, expireBy };
}

export interface WebhookOutcome {
  status: string;
}

interface AfterCommit {
  dispatchBookingId?: number;
  customerPhone?: string;
  customerMessage?: string;
  /** Booking code and plain update text for the template sent outside the service window. */
  customerUpdate?: { bookingCode: string; text: string };
  adminAlert?: string;
  /** Driver notice (dues payment received). */
  driverNotice?: { phone: string; text: string };
}

/**
 * Process one verified Razorpay webhook event. The event id is claimed in the same transaction as
 * the payment update, so a failure rolls both back and Razorpay's retry is processed normally, while
 * a repeat delivery after success is ignored.
 */
export async function processRazorpayEvent(eventId: string, event: any): Promise<WebhookOutcome> {
  const eventType = String(event?.event || '');
  const after: AfterCommit = {};

  const outcome = await withTransaction(async (client) => {
    const claim = await client.query(
      `INSERT INTO crm_payment_webhook_events (event_id, event_type) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, eventType || 'unknown']
    );
    if ((claim.rowCount ?? 0) === 0) return { status: 'duplicate_ignored' };

    if (eventType === 'payment_link.paid') return handlePaid(client, event, after);
    if (eventType === 'payment_link.expired' || eventType === 'payment_link.cancelled') {
      return handleClosed(client, event, eventType === 'payment_link.expired' ? 'EXPIRED' : 'CANCELLED', after);
    }
    if (eventType === 'refund.processed' || eventType === 'refund.failed') return handleRefundEvent(client, event, eventType, after);
    return { status: 'ignored_event_type' };
  });

  await runAfterCommit(after);
  return outcome;
}

async function handlePaid(client: PoolClient, event: any, after: AfterCommit): Promise<WebhookOutcome> {
  const linkEntity = event?.payload?.payment_link?.entity;
  const payment = event?.payload?.payment?.entity;
  const linkRes = await client.query(
    `SELECT * FROM crm_payment_links WHERE provider_link_id = $1 FOR UPDATE`,
    [String(linkEntity?.id || '')]
  );
  const link = linkRes.rows[0];
  if (!link) return { status: 'unknown_link_ignored' };
  if (link.status === 'PAID') return { status: 'already_paid' };

  // Trust only what matches the link we created: exact amount, INR, captured.
  const matches =
    linkEntity?.status === 'paid' &&
    Number(linkEntity?.amount_paid) === Number(link.amount_paise) &&
    payment?.status === 'captured' &&
    Number(payment?.amount) === Number(link.amount_paise) &&
    String(payment?.currency || '').toUpperCase() === link.currency &&
    typeof payment?.id === 'string';

  if (link.purpose === 'DRIVER_DUES') return handleDuesPaid(client, link, payment, matches, after);

  const bookingRes = await client.query(
    `SELECT b.*, c.phone AS customer_phone FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id
     WHERE b.id = $1 FOR UPDATE OF b`,
    [link.booking_id]
  );
  const b = bookingRes.rows[0];

  if (!matches) {
    await client.query(
      `UPDATE crm_payment_links SET status = 'REVIEW_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [link.id]
    );
    console.error(`[Razorpay] Payment for link ${link.provider_link_id} does not match the expected advance; booking ${b.booking_code} left unconfirmed.`);
    after.adminAlert = `⚠️ Advance payment for booking ${b.booking_code} did not match the expected ₹${(link.amount_paise / 100).toFixed(2)}. The booking was NOT confirmed. Check Razorpay link ${link.provider_link_id}.`;
    return { status: 'amount_mismatch_review' };
  }

  const amount = Number(link.amount_paise) / 100;
  // GST is due on an advance when it is received (18%: rate not determinable at receipt, per CA). The advance
  // includes it. A consecutive receipt voucher number is recorded for the receipt.
  const advanceGst = gstIncluded(amount, (await getRevenueProtectionPolicy()).advance_gst_pct);
  const voucher = await client.query(`SELECT nextval('crm_receipt_voucher_seq') AS n`);
  const voucherNumber = `RV${financialYearCode(new Date())}${String(voucher.rows[0].n).padStart(6, '0')}`;
  await client.query(
    `UPDATE crm_payment_links
     SET status = 'PAID', provider_payment_id = $1, paid_at = CURRENT_TIMESTAMP, gst_amount = $3, receipt_voucher_number = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [payment.id, link.id, advanceGst, voucherNumber]
  );
  await client.query(`UPDATE crm_bookings SET advance_gst_amount = advance_gst_amount + $1 WHERE id = $2`, [advanceGst, b.id]);
  await client.query(
    `INSERT INTO crm_payments_ledger (booking_id, customer_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
     VALUES ($1, $2, 'CUSTOMER_ADVANCE', 'CREDIT', 'RAZORPAY', $3, $4, $5)`,
    [b.id, b.customer_id, amount, payment.id, `Advance via Razorpay link ${link.provider_link_id}; receipt voucher ${voucherNumber}; GST included ₹${advanceGst.toFixed(2)}`]
  );

  if (b.booking_status !== 'AWAITING_ADVANCE') {
    // Paid after the booking closed (e.g. expired). Record the money; staff decide: reinstate or refund.
    await client.query(
      `UPDATE crm_bookings SET advance_paid = $1, advance_status = 'PAID_AFTER_CLOSE', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [amount, b.id]
    );
    after.adminAlert = `⚠️ Advance ₹${amount.toFixed(2)} received for booking ${b.booking_code}, which is ${b.booking_status}. Reinstate the booking or refund payment ${payment.id}.`;
    return { status: 'paid_after_close_review' };
  }

  const fare = Number(b.customer_total_fare);
  await client.query(
    `UPDATE crm_bookings
     SET advance_paid = $1,
         advance_status = 'PAID',
         payment_status = $2,
         balance_cash_due_from_customer = $3,
         booking_status = 'CONFIRMED_AWAITING_DRIVER',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [amount, amount >= fare ? 'PAID_IN_FULL' : 'ADVANCE_PAID', Math.max(0, fare - amount), b.id]
  );

  after.dispatchBookingId = b.id;
  after.customerPhone = b.customer_phone;
  after.customerMessage = `✅ Advance ₹${amount.toLocaleString('en-IN')} received for booking #${b.booking_code}. Your booking is confirmed and we are assigning your driver now.\nBalance payable to the driver at drop: ₹${Math.max(0, fare - amount).toLocaleString('en-IN')}`;
  after.customerUpdate = {
    bookingCode: b.booking_code,
    text: `Advance ₹${amount.toLocaleString('en-IN')} received. Your booking is confirmed and we are assigning your driver. Balance payable to the driver at drop: ₹${Math.max(0, fare - amount).toLocaleString('en-IN')}.`,
  };
  return { status: 'advance_confirmed' };
}

/**
 * A driver paid their dues link. The money is recorded on the driver's wallet (no GST: it settles commission
 * already invoiced), and a dues restriction is lifted if they are back within their credit limit.
 */
async function handleDuesPaid(client: PoolClient, link: any, payment: any, matches: boolean, after: AfterCommit): Promise<WebhookOutcome> {
  if (!matches) {
    await client.query(`UPDATE crm_payment_links SET status = 'REVIEW_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [link.id]);
    after.adminAlert = `⚠️ Dues payment for driver #${link.driver_id} did not match the expected ₹${(link.amount_paise / 100).toFixed(2)}. Nothing was credited. Check Razorpay link ${link.provider_link_id}.`;
    return { status: 'amount_mismatch_review' };
  }
  await client.query(
    `UPDATE crm_payment_links SET status = 'PAID', provider_payment_id = $1, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [payment.id, link.id]
  );
  const amount = Number(link.amount_paise) / 100;
  const result = await applyDuesPayment(client, {
    driverId: Number(link.driver_id), amount, channel: 'RAZORPAY', reference: payment.id,
    notes: `Dues paid via Razorpay link ${link.provider_link_id}`, adminId: null, source: 'RAZORPAY',
  });
  const d = (await client.query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [link.driver_id])).rows[0];
  const balance = result.newWalletBalance;
  after.driverNotice = {
    phone: d.whatsapp_phone || d.phone,
    text: `Dues payment of ₹${amount.toLocaleString('en-IN')} received. ${balance < 0 ? `Still owed: ₹${Math.abs(balance).toLocaleString('en-IN')}.` : 'You have no dues.'}${result.restored ? ' Your account is active again for all rides.' : ''}`,
  };
  return { status: 'dues_payment_recorded' };
}

/**
 * Razorpay reports a refund's outcome. Matched on the refund id, or on our receipt ("refund-<id>"), because
 * the webhook can arrive before the refund API response stored Razorpay's id. Only the amount we asked for
 * is accepted.
 */
async function handleRefundEvent(client: PoolClient, event: any, eventType: string, after: AfterCommit): Promise<WebhookOutcome> {
  const entity = event?.payload?.refund?.entity;
  const receiptId = /^refund-(\d+)$/.exec(String(entity?.receipt || ''))?.[1];
  const res = await client.query(
    `SELECT r.*, b.booking_code FROM crm_refunds r JOIN crm_bookings b ON b.id = r.booking_id
     WHERE r.provider_refund_id = $1 OR r.id = $2 ORDER BY (r.provider_refund_id = $1) DESC LIMIT 1 FOR UPDATE OF r`,
    [String(entity?.id || ''), receiptId ? Number(receiptId) : 0]
  );
  const refund = res.rows[0];
  if (!refund) return { status: 'unknown_refund_ignored' };
  if (Number(entity?.amount) !== Number(refund.amount_paise) || String(entity?.payment_id || '') !== refund.provider_payment_id) {
    after.adminAlert = `⚠️ Razorpay refund ${entity?.id} for booking #${refund.booking_code} does not match the refund BiharCabs requested. Check it in Razorpay.`;
    return { status: 'refund_mismatch_review' };
  }
  if (eventType === 'refund.processed') {
    const booked = await markRefundProcessed(client, Number(refund.id), String(entity.id));
    return { status: booked ? 'refund_processed' : 'refund_already_processed' };
  }
  if (refund.status === 'PROCESSED') return { status: 'refund_already_processed' };
  await client.query(
    `UPDATE crm_refunds SET status = 'FAILED', provider_refund_id = COALESCE(provider_refund_id, $1), last_error = 'Razorpay reported the refund failed', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [String(entity.id), refund.id]
  );
  after.adminAlert = `⚠️ Razorpay could not process the ₹${(refund.amount_paise / 100).toFixed(2)} refund for cancelled booking #${refund.booking_code}. Retry it from Finance → Refunds.`;
  return { status: 'refund_failed' };
}

async function handleClosed(client: PoolClient, event: any, newLinkStatus: 'EXPIRED' | 'CANCELLED', after: AfterCommit): Promise<WebhookOutcome> {
  const linkEntity = event?.payload?.payment_link?.entity;
  const linkRes = await client.query(
    `SELECT * FROM crm_payment_links WHERE provider_link_id = $1 FOR UPDATE`,
    [String(linkEntity?.id || '')]
  );
  const link = linkRes.rows[0];
  if (!link) return { status: 'unknown_link_ignored' };
  if (link.status !== 'CREATED') return { status: 'link_already_closed' };

  await client.query(
    `UPDATE crm_payment_links SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [newLinkStatus, link.id]
  );
  // An unpaid dues link just closes; the dues stay on the wallet and the driver can ask for a new link.
  if (link.purpose === 'DRIVER_DUES') return { status: newLinkStatus === 'EXPIRED' ? 'dues_link_expired' : 'dues_link_cancelled' };
  const bRes = await client.query(
    `UPDATE crm_bookings b
     SET booking_status = 'ADVANCE_EXPIRED', advance_status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
     FROM crm_customers c
     WHERE b.id = $1 AND c.id = b.customer_id AND b.booking_status = 'AWAITING_ADVANCE'
     RETURNING b.booking_code, c.phone AS customer_phone`,
    [link.booking_id]
  );
  if (bRes.rows[0]) {
    after.customerPhone = bRes.rows[0].customer_phone;
    after.customerMessage = `Booking #${bRes.rows[0].booking_code} was not confirmed because the advance was not received in time. Reply *HI* to book again.`;
    after.customerUpdate = { bookingCode: bRes.rows[0].booking_code, text: 'Not confirmed: the advance was not received in time. Reply HI to book again.' };
  }
  return { status: newLinkStatus === 'EXPIRED' ? 'booking_expired' : 'booking_cancelled' };
}

/** Messages and dispatch run only after the payment is committed. A failure here is logged; the booking stays visible to staff. */
async function runAfterCommit(after: AfterCommit): Promise<boolean> {
  let dispatched = false;
  if (after.customerPhone && after.customerMessage) {
    const phone = after.customerPhone;
    const message = after.customerMessage;
    try {
      if (after.customerUpdate) {
        await notify(phone, 'customer_booking_update', {
          params: [`#${after.customerUpdate.bookingCode}`, after.customerUpdate.text],
          freeform: () => sendWhatsAppText(phone, message),
        });
      } else {
        await sendWhatsAppText(phone, message);
      }
    } catch (err: any) {
      console.error('[Advance] Customer notification failed:', err?.message);
    }
  }
  if (after.dispatchBookingId) {
    try {
      const result = await broadcastRideToDrivers(after.dispatchBookingId);
      await notifyOfferedDrivers(after.dispatchBookingId, result);
      dispatched = true;
    } catch (err: any) {
      console.error(`[Advance] Dispatch after payment failed for booking #${after.dispatchBookingId}; it stays CONFIRMED_AWAITING_DRIVER for manual broadcast:`, err?.message);
    }
  }
  if (after.adminAlert) await notifyAdmins(after.adminAlert);
  if (after.driverNotice) {
    const { phone, text } = after.driverNotice;
    try {
      await notify(phone, 'driver_account_notice', { params: [text], freeform: () => sendWhatsAppText(phone, `✅ ${text}`) });
    } catch (err: any) {
      console.error('[Dues] Driver notification failed:', err?.message);
    }
  }
  return dispatched;
}

// ---------------------------------------------------------------------------------------------
// Waiving the advance on a booking that is waiting for it (finance / super admin)
// ---------------------------------------------------------------------------------------------

export { MIN_WAIVER_REASON_LENGTH, WAIVABLE_STATUSES };

export class WaiverError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Make sure the customer can no longer pay this link. Cancels it at Razorpay; if Razorpay refuses,
 * checks the link's state: already expired or cancelled is fine, paid means the waiver must not happen.
 */
export async function closeLinkAtRazorpay(providerLinkId: string): Promise<void> {
  try {
    await cancelPaymentLink(providerLinkId);
    return;
  } catch (cancelErr: any) {
    let status: string;
    try {
      status = await fetchPaymentLinkStatus(providerLinkId);
    } catch {
      throw new WaiverError(`Could not cancel the payment link at Razorpay (${cancelErr?.message}). Nothing was changed; try again.`, 502);
    }
    if (status === 'cancelled' || status === 'expired') return;
    if (status === 'paid' || status === 'partially_paid') {
      throw new WaiverError('The customer has already paid this advance; its confirmation is on the way. Nothing was waived.', 409);
    }
    throw new WaiverError(`Could not cancel the payment link at Razorpay (${cancelErr?.message}). Nothing was changed; try again.`, 502);
  }
}

export interface WaiveAdvanceResult {
  bookingCode: string;
  dispatched: boolean;
}

/**
 * Waive the advance on a booking that is waiting for it: the ride becomes full cash to the driver
 * and goes to drivers. The payment link is cancelled at Razorpay first, so the customer cannot pay
 * after the waiver; if that cannot be confirmed, nothing changes.
 */
export async function waiveBookingAdvance(input: { bookingId: number; adminId: number; reason: string }): Promise<WaiveAdvanceResult> {
  const reason = String(input.reason || '').trim();
  if (reason.length < MIN_WAIVER_REASON_LENGTH) {
    throw new WaiverError(`A waiver needs a reason of at least ${MIN_WAIVER_REASON_LENGTH} characters.`, 400);
  }

  const bRes = await query(`SELECT * FROM crm_bookings WHERE id = $1`, [input.bookingId]);
  const booking = bRes.rows[0];
  if (!booking) throw new WaiverError('Booking not found.', 404);
  checkWaivable(booking);

  const openLinks = await query(
    `SELECT provider_link_id FROM crm_payment_links WHERE booking_id = $1 AND status = 'CREATED'`,
    [input.bookingId]
  );
  for (const link of openLinks.rows) await closeLinkAtRazorpay(link.provider_link_id);

  const after: AfterCommit = {};
  const bookingCode = await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT b.*, c.phone AS customer_phone FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [input.bookingId]
    );
    const b = locked.rows[0];
    checkWaivable(b); // A payment webhook may have landed while the link was being cancelled.

    await client.query(
      `UPDATE crm_payment_links SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND status = 'CREATED'`,
      [b.id]
    );
    const fare = Number(b.customer_total_fare);
    await client.query(
      `UPDATE crm_bookings
       SET payment_mode = 'FULL_CASH',
           advance_due_amount = 0,
           advance_status = 'WAIVED',
           advance_waived_by = $1,
           advance_waiver_reason = $2,
           balance_cash_due_from_customer = $3,
           booking_status = 'CONFIRMED_AWAITING_DRIVER',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [input.adminId, reason, Math.max(0, fare - Number(b.advance_paid || 0)), b.id]
    );

    after.dispatchBookingId = Number(b.id);
    after.customerPhone = b.customer_phone;
    after.customerMessage = `✅ Booking #${b.booking_code} is confirmed without an online advance. Please pay the full fare of ₹${fare.toLocaleString('en-IN')} in cash to the driver at drop. We are assigning your driver now.`;
    after.customerUpdate = { bookingCode: b.booking_code, text: `Confirmed without an online advance. Pay the full fare of ₹${fare.toLocaleString('en-IN')} in cash to the driver at drop. We are assigning your driver.` };
    return String(b.booking_code);
  });

  console.info(`[Advance] Advance waived on ${bookingCode} by admin #${input.adminId}`);
  const dispatched = await runAfterCommit(after);
  return { bookingCode, dispatched };
}

/** Indian financial year (April–March) as "2627" for 2026-27, used in receipt voucher numbers. */
export function financialYearCode(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

function checkWaivable(b: any): void {
  if (b.advance_status === 'PAID_AFTER_CLOSE') {
    throw new WaiverError('The customer already paid this advance after the booking closed. Reinstate or refund it instead of waiving.', 409);
  }
  if (!WAIVABLE_STATUSES.includes(b.booking_status)) {
    throw new WaiverError(`Booking ${b.booking_code} is not waiting for an advance (status ${b.booking_status}).`, 409);
  }
  if (bookingPickupAt(b).getTime() <= Date.now()) {
    throw new WaiverError(`The pickup time for booking ${b.booking_code} has already passed.`, 409);
  }
}

/** Customer-facing text with the payment link, used by the bot and the admin booking route. */
export async function advanceLinkMessage(bookingCode: string, request: AdvanceRequestResult, balanceDue: number): Promise<string> {
  const company = await getCompanyBillingInfo().catch(() => null);
  const minutes = Math.max(1, Math.round((request.expireBy.getTime() - Date.now()) / 60000));
  return (
    `📲 Pay ₹${request.amount.toLocaleString('en-IN')} advance to confirm booking #${bookingCode}:\n${request.shortUrl}\n\n` +
    `The link is valid for ${minutes} minutes. We assign your driver as soon as the payment is received.\n` +
    `Balance payable to the driver at drop: ₹${balanceDue.toLocaleString('en-IN')}` +
    (company?.phone ? `\nHelp: ${company.phone}` : '')
  );
}
