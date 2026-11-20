/**
 * GST documents are sent to customers on WhatsApp (per CA): a document message inside the 24-hour window,
 * otherwise the customer_gst_document template with the PDF in its header; documents wait for BiharCabs'
 * GSTIN and their place of supply; failures are retried, then marked FAILED and reported once; documents
 * issued before migration 29 are never sent. Runs against a disposable database whose name ends in _test
 * (migrations 08 to 29):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/gst-delivery.integration.ts
 *
 * WhatsApp is simulated when no Meta token is configured: media uploads return a simulated id and each
 * message payload is logged to crm_whatsapp_logs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { processRazorpayEvent } from '../lib/advance-payments';
import { setDocumentPlaceOfSupply } from '../lib/place-of-supply';
import { sendPendingGstDocuments } from '../lib/gst-delivery';
import { executeFrequentCronTasks } from '../lib/cron-service';
import { notify } from '../lib/wa-notify';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let adminId = 0;
let originalCompany: any;
let originalTemplates: any;
let originalDelivery: any;
const GSTIN_BIHAR = '10ABCDE1234F1Z5'; // well-formed test GSTIN, not a real registration

/** A booking whose ₹500 advance is paid through the real webhook handler, issuing a receipt voucher. */
async function receiptVoucher(pickupCity = 'Patna') {
  const phone = `9156${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Delivery Customer') RETURNING id`, [phone]);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status, advance_status, payment_mode)
     VALUES ($1, $2, 'oneway', $3, 'Gaya', 'Main Road', CURRENT_DATE + 3, '10:00', 'sedan', 2500, 2280, 220, 'AWAITING_ADVANCE', 'PENDING', 'ADVANCE_ONLINE')
     RETURNING id, booking_code`,
    [`BC-W${RUN}${seq++}`, cu.rows[0].id, pickupCity]
  );
  const linkId = `plink_w${RUN}${seq++}`;
  await query(
    `INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, short_url, status, expire_by)
     VALUES ($1, $2, $2, 50000, 'https://rzp.io/test', 'CREATED', CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
    [b.rows[0].id, linkId]
  );
  await processRazorpayEvent(`evt_w${RUN}${seq++}`, {
    entity: 'event', event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: linkId, amount: 50000, amount_paid: 50000, status: 'paid' } },
      payment: { entity: { id: `pay_w${RUN}${seq++}`, amount: 50000, currency: 'INR', status: 'captured' } },
    },
  });
  const link = (await query(`SELECT * FROM crm_payment_links WHERE provider_link_id = $1`, [linkId])).rows[0];
  return { id: Number(link.id), number: link.receipt_voucher_number as string, phone, bookingCode: b.rows[0].booking_code as string };
}
const rv = async (id: number) => (await query(`SELECT wa_delivery_status, wa_attempts, wa_sent_at, wa_last_error FROM crm_payment_links WHERE id = $1`, [id])).rows[0];
/** Document messages, or GST document templates, sent to a phone (other notifications are left out). */
const sentTo = async (phone: string, type: 'template' | 'document') =>
  (await query(`SELECT payload FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND phone = $1 AND message_type = $2 ORDER BY id`, [phone, type])).rows
    .map((r) => r.payload)
    .filter((p) => type === 'document' || p.template?.name === 'bc_customer_gst_document');
const openWindow = (phone: string) =>
  query(`INSERT INTO crm_whatsapp_logs (direction, phone, message_type, payload, status) VALUES ('INBOUND', $1, 'text', '{}'::jsonb, 'RECEIVED')`, [phone]);

before(async () => {
  const s = await getAllSettings(true);
  originalCompany = s.company_billing_info;
  originalTemplates = s.whatsapp_templates;
  originalDelivery = s.gst_document_delivery;
  assert.strictEqual(originalTemplates.customer_gst_document, 'bc_customer_gst_document', 'migration 29 sets the template name');
  assert.strictEqual(originalDelivery.max_attempts, 3);
  // Earlier suites leave documents pending; set them aside so each run below sends only this suite's.
  for (const t of ['crm_invoices', 'crm_payment_links', 'crm_refunds', 'crm_cancellation_charges']) {
    await query(`UPDATE ${t} SET wa_delivery_status = 'NOT_SENT' WHERE wa_delivery_status = 'PENDING'`);
  }
  await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Delivery Tester', 'FINANCE_MANAGER', false) RETURNING id`,
    [`delivery-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
});
after(async () => {
  if (originalCompany !== undefined) await updateSetting('company_billing_info', originalCompany);
  if (originalTemplates !== undefined) await updateSetting('whatsapp_templates', originalTemplates);
  if (originalDelivery !== undefined) await updateSetting('gst_document_delivery', originalDelivery);
  await getDbPool().end();
});

describe('sending', () => {
  it('outside the 24-hour window: the template, with the PDF in its header and the document named in the text', async () => {
    const doc = await receiptVoucher();
    assert.strictEqual((await rv(doc.id)).wa_delivery_status, 'PENDING', 'new documents wait to be sent');
    const r = await sendPendingGstDocuments();
    assert.ok(r.sent >= 1);
    const state = await rv(doc.id);
    assert.strictEqual(state.wa_delivery_status, 'SENT');
    assert.ok(state.wa_sent_at);
    const [msg] = await sentTo(doc.phone, 'template');
    assert.strictEqual(msg.template.name, 'bc_customer_gst_document');
    const header = msg.template.components.find((c: any) => c.type === 'header');
    assert.match(header.parameters[0].document.id, /^local-sim-media-/, 'sent by uploaded media id, not a public link');
    assert.strictEqual(header.parameters[0].document.filename, `${doc.number}.pdf`);
    const body = msg.template.components.find((c: any) => c.type === 'body');
    assert.deepStrictEqual(body.parameters.map((p: any) => p.text), ['receipt voucher', doc.number, `#${doc.bookingCode}`]);
  });

  it('inside the window: a document message with a caption', async () => {
    const doc = await receiptVoucher();
    await openWindow(doc.phone);
    await sendPendingGstDocuments();
    assert.strictEqual((await rv(doc.id)).wa_delivery_status, 'SENT');
    const [msg] = await sentTo(doc.phone, 'document');
    assert.match(msg.document.id, /^local-sim-media-/);
    assert.strictEqual(msg.document.filename, `${doc.number}.pdf`);
    assert.ok(msg.document.caption.includes(doc.number));
    assert.strictEqual((await sentTo(doc.phone, 'template')).length, 0);
  });

  it('a document is sent once', async () => {
    const doc = await receiptVoucher();
    await sendPendingGstDocuments();
    await sendPendingGstDocuments();
    assert.strictEqual((await sentTo(doc.phone, 'template')).length, 1);
  });

  it('runs in the frequent job', async () => {
    const doc = await receiptVoucher();
    const result = await executeFrequentCronTasks();
    assert.ok(result.gstDocumentsSent >= 1);
    assert.strictEqual((await rv(doc.id)).wa_delivery_status, 'SENT');
  });
});

describe('waiting', () => {
  it('nothing is sent, and no attempt used, while BiharCabs\' GSTIN is missing', async () => {
    const doc = await receiptVoucher();
    await updateSetting('company_billing_info', { ...originalCompany, gstin: '' });
    try {
      assert.strictEqual((await sendPendingGstDocuments()).waitingForGstin, true);
      const state = await rv(doc.id);
      assert.strictEqual(state.wa_delivery_status, 'PENDING');
      assert.strictEqual(state.wa_attempts, 0);
    } finally {
      await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
    }
    await sendPendingGstDocuments();
    assert.strictEqual((await rv(doc.id)).wa_delivery_status, 'SENT', 'sent once the GSTIN is set');
  });

  it('a document without a place of supply waits, and is sent once finance chooses it', async () => {
    const doc = await receiptVoucher(`Waitpur${RUN}`);
    await sendPendingGstDocuments();
    assert.strictEqual((await rv(doc.id)).wa_attempts, 0);
    assert.strictEqual((await sentTo(doc.phone, 'template')).length, 0);
    await setDocumentPlaceOfSupply({ kind: 'RV', id: doc.id, stateCode: '10', rememberCity: false, adminId });
    await sendPendingGstDocuments();
    assert.strictEqual((await rv(doc.id)).wa_delivery_status, 'SENT');
  });

  it('documents issued before delivery existed are never sent', async () => {
    const old = (await query(`SELECT COUNT(*)::int AS n FROM crm_invoices WHERE wa_delivery_status = 'NOT_SENT'`)).rows[0].n;
    assert.ok(old > 0, 'migration 29 marked existing documents NOT_SENT');
    await sendPendingGstDocuments();
    assert.strictEqual((await query(`SELECT COUNT(*)::int AS n FROM crm_invoices WHERE wa_delivery_status = 'NOT_SENT'`)).rows[0].n, old);
  });
});

describe('failures', () => {
  it('retried up to max_attempts, then FAILED and reported once under Failed messages', async () => {
    const doc = await receiptVoucher();
    const { customer_gst_document: _removed, ...rest } = originalTemplates;
    await updateSetting('whatsapp_templates', rest); // outside the window and no approved template: the send fails
    try {
      await sendPendingGstDocuments();
      let state = await rv(doc.id);
      assert.strictEqual(state.wa_delivery_status, 'PENDING', 'retried on the next run');
      assert.strictEqual(state.wa_attempts, 1);
      assert.ok(state.wa_last_error.includes('No template configured'));
      await sendPendingGstDocuments();
      await sendPendingGstDocuments();
      state = await rv(doc.id);
      assert.strictEqual(state.wa_delivery_status, 'FAILED');
      assert.strictEqual(state.wa_attempts, 3);
      await sendPendingGstDocuments();
      assert.strictEqual((await rv(doc.id)).wa_attempts, 3, 'no more tries');
      const reported = (await query(`SELECT * FROM crm_notification_failures WHERE phone = $1`, [doc.phone])).rows;
      assert.strictEqual(reported.length, 1, 'reported once, not per try');
      assert.strictEqual(reported[0].template_key, 'customer_gst_document');
      assert.strictEqual(reported[0].booking_code, doc.bookingCode);
    } finally {
      await updateSetting('whatsapp_templates', originalTemplates);
    }
  });

  it('the document template cannot be sent without its PDF', async () => {
    await assert.rejects(notify('919999999999', 'customer_gst_document', { params: ['tax invoice', 'TI2627000001', '#BC-X'] }), /document is required/);
  });
});
