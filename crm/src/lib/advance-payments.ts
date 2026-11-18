import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { createPaymentLink } from './razorpay';
import { AdvanceCollectionPolicy, getAdminContacts, getAdvanceCollectionPolicy, getCompanyBillingInfo } from './settings';
import { broadcastRideToDrivers } from './dispatch-engine';
import { notifyOfferedDrivers } from './dispatch-notify';
import { sendWhatsAppText } from './whatsapp';

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
  adminAlert?: string;
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
  await client.query(
    `UPDATE crm_payment_links SET status = 'PAID', provider_payment_id = $1, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [payment.id, link.id]
  );
  await client.query(
    `INSERT INTO crm_payments_ledger (booking_id, customer_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
     VALUES ($1, $2, 'CUSTOMER_ADVANCE', 'CREDIT', 'RAZORPAY', $3, $4, $5)`,
    [b.id, b.customer_id, amount, payment.id, `Advance via Razorpay link ${link.provider_link_id}`]
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
  return { status: 'advance_confirmed' };
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
  }
  return { status: newLinkStatus === 'EXPIRED' ? 'booking_expired' : 'booking_cancelled' };
}

/** Messages and dispatch run only after the payment is committed. A failure here is logged; the booking stays visible to staff. */
async function runAfterCommit(after: AfterCommit): Promise<void> {
  if (after.customerPhone && after.customerMessage) {
    try {
      await sendWhatsAppText(after.customerPhone, after.customerMessage);
    } catch (err: any) {
      console.error('[Advance] Customer notification failed:', err?.message);
    }
  }
  if (after.dispatchBookingId) {
    try {
      const result = await broadcastRideToDrivers(after.dispatchBookingId);
      await notifyOfferedDrivers(after.dispatchBookingId, result);
    } catch (err: any) {
      console.error(`[Advance] Dispatch after payment failed for booking #${after.dispatchBookingId}; it stays CONFIRMED_AWAITING_DRIVER for manual broadcast:`, err?.message);
    }
  }
  if (after.adminAlert) {
    try {
      for (const admin of await getAdminContacts()) {
        if (admin.phone) await sendWhatsAppText(admin.phone, after.adminAlert);
      }
    } catch (err: any) {
      console.error('[Advance] Admin alert failed:', err?.message);
    }
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
