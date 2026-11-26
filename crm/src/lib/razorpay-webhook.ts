import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { fetchPaymentLinkStatus } from './razorpay';
import { applyDuesPayment } from './driver-dues';
import { activateDriverPlanFromPayment } from './driver-plans';
import { sendWhatsAppText } from './whatsapp';
import { notify, notifyAdmins } from './wa-notify';

/**
 * Razorpay webhook processor for Driver Dues (purpose = 'DRIVER_DUES')
 * and Driver Subscription Plans (purpose = 'DRIVER_PLAN').
 * Customer advance payment links have been retired.
 */

export interface WebhookOutcome {
  status: string;
}

interface AfterCommit {
  adminAlert?: string;
  driverNotice?: { phone: string; text: string };
}

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
      return handleClosed(client, event, eventType === 'payment_link.expired' ? 'EXPIRED' : 'CANCELLED');
    }
    return { status: 'ignored_event_type' };
  });

  if (after.adminAlert) {
    await notifyAdmins(after.adminAlert).catch((err) => console.error('[Razorpay] Admin alert failed:', err?.message));
  }
  if (after.driverNotice) {
    const { phone, text } = after.driverNotice;
    await notify(phone, 'driver_account_notice', {
      params: [text],
      freeform: () => sendWhatsAppText(phone, text),
    }).catch((err) => console.error('[Razorpay] Driver notice failed:', err?.message));
  }

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

  const matches =
    linkEntity?.status === 'paid' &&
    Number(linkEntity?.amount_paid) === Number(link.amount_paise) &&
    payment?.status === 'captured' &&
    Number(payment?.amount) === Number(link.amount_paise) &&
    String(payment?.currency || '').toUpperCase() === link.currency &&
    typeof payment?.id === 'string';

  if (link.purpose === 'DRIVER_DUES') {
    return handleDuesPaid(client, link, payment, matches, after);
  }
  if (link.purpose === 'DRIVER_PLAN') {
    return handlePlanPaid(client, link, payment, matches, after);
  }

  return { status: 'unsupported_link_purpose' };
}

async function handleDuesPaid(
  client: PoolClient,
  link: any,
  payment: any,
  matches: boolean,
  after: AfterCommit
): Promise<WebhookOutcome> {
  if (!matches) {
    await client.query(
      `UPDATE crm_payment_links SET status = 'REVIEW_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [link.id]
    );
    after.adminAlert = `⚠️ Dues payment for driver #${link.driver_id} did not match the expected ₹${(link.amount_paise / 100).toFixed(2)}. Nothing was credited. Check Razorpay link ${link.provider_link_id}.`;
    return { status: 'amount_mismatch_review' };
  }

  await client.query(
    `UPDATE crm_payment_links SET status = 'PAID', provider_payment_id = $1, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [payment.id, link.id]
  );

  const amount = Number(link.amount_paise) / 100;
  const result = await applyDuesPayment(client, {
    driverId: Number(link.driver_id),
    amount,
    channel: 'RAZORPAY',
    reference: payment.id,
    notes: `Dues paid via Razorpay link ${link.provider_link_id}`,
    adminId: null,
    source: 'RAZORPAY',
  });

  const d = (await client.query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [link.driver_id])).rows[0];
  const phone = d?.whatsapp_phone || d?.phone;
  if (phone) {
    after.driverNotice = {
      phone,
      text:
        `✅ Dues payment of ₹${amount.toLocaleString('en-IN')} received.` +
        (result.restored ? ' Your account is now active for rides again.' : ` Current wallet balance: ₹${result.newWalletBalance.toFixed(2)}.`),
    };
  }
  return { status: 'dues_paid' };
}

async function handlePlanPaid(
  client: PoolClient,
  link: any,
  payment: any,
  matches: boolean,
  after: AfterCommit
): Promise<WebhookOutcome> {
  if (!matches) {
    await client.query(
      `UPDATE crm_payment_links SET status = 'REVIEW_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [link.id]
    );
    after.adminAlert = `⚠️ Plan payment for driver #${link.driver_id} did not match ₹${(link.amount_paise / 100).toFixed(2)}. Plan NOT activated. Check link ${link.provider_link_id}.`;
    return { status: 'amount_mismatch_review' };
  }

  await client.query(
    `UPDATE crm_payment_links SET status = 'PAID', provider_payment_id = $1, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [payment.id, link.id]
  );

  const amount = Number(link.amount_paise) / 100;
  const activated = await activateDriverPlanFromPayment(client, Number(link.driver_plan_id), amount, payment.id);

  const d = (await client.query(`SELECT phone, whatsapp_phone FROM crm_drivers WHERE id = $1`, [link.driver_id])).rows[0];
  const phone = d?.whatsapp_phone || d?.phone;
  if (phone) {
    after.driverNotice = {
      phone,
      text: `✅ ${activated.planName} Plan activated! Added balance: ₹${activated.addedBalance.toFixed(2)}. Total available plan balance: ₹${activated.newBalance.toFixed(2)} (Invoice ${activated.invoiceNumber}).`,
    };
  }
  return { status: 'plan_activated' };
}

async function handleClosed(client: PoolClient, event: any, nextStatus: 'EXPIRED' | 'CANCELLED'): Promise<WebhookOutcome> {
  const linkId = String(event?.payload?.payment_link?.entity?.id || '');
  const res = await client.query(
    `UPDATE crm_payment_links SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE provider_link_id = $2 AND status = 'CREATED'
     RETURNING id, purpose, driver_plan_id`,
    [nextStatus, linkId]
  );
  const row = res.rows[0];
  if (!row) return { status: 'already_closed_or_unknown' };
  if (row.purpose === 'DRIVER_PLAN' && row.driver_plan_id) {
    await client.query(
      `UPDATE crm_driver_plans SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
      [row.driver_plan_id]
    );
  }
  return { status: `link_${nextStatus.toLowerCase()}` };
}

/**
 * Reconcile open DRIVER_DUES / DRIVER_PLAN Razorpay payment links past their expiry.
 */
export async function reconcileStalePaymentLinks(): Promise<{ checked: number; closed: number; paidAlerts: number }> {
  const stale = await query(
    `SELECT id, purpose, driver_id, driver_plan_id, provider_link_id, amount_paise, reconcile_alerted_at
     FROM crm_payment_links
     WHERE status = 'CREATED'
       AND purpose IN ('DRIVER_DUES', 'DRIVER_PLAN')
       AND expire_by < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
     ORDER BY expire_by ASC
     LIMIT 25`
  );

  let closed = 0;
  let paidAlerts = 0;

  for (const link of stale.rows) {
    const remoteStatus = await fetchPaymentLinkStatus(link.provider_link_id);
    if (remoteStatus === 'expired' || remoteStatus === 'cancelled') {
      const nextStatus = remoteStatus === 'expired' ? 'EXPIRED' : 'CANCELLED';
      await query(
        `UPDATE crm_payment_links SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = 'CREATED'`,
        [nextStatus, link.id]
      );
      if (link.purpose === 'DRIVER_PLAN' && link.driver_plan_id) {
        await query(
          `UPDATE crm_driver_plans SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
          [link.driver_plan_id]
        );
      }
      closed++;
    } else if (remoteStatus === 'paid' && !link.reconcile_alerted_at) {
      const alerted = await notifyAdmins(
        `⚠️ Razorpay reports ${link.purpose} link ${link.provider_link_id} (driver #${link.driver_id}, ₹${(link.amount_paise / 100).toFixed(2)}) as PAID, but the webhook was not received. Verify in Razorpay.`
      );
      if (alerted > 0) {
        await query(`UPDATE crm_payment_links SET reconcile_alerted_at = CURRENT_TIMESTAMP WHERE id = $1`, [link.id]);
        paidAlerts++;
      } else {
        console.error(`[Razorpay Reconcile] Admin alert for paid link ${link.provider_link_id} did not deliver; will retry next run.`);
      }
    }
  }

  return { checked: stale.rows.length, closed, paidAlerts };
}
