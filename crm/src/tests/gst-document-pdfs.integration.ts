/**
 * Receipt vouchers, refund vouchers and cancellation charge documents carry a place of supply and the
 * CGST/SGST or IGST split (per CA); refunds and cancellation charges follow their receipt voucher; and
 * every GST document (TI, RV, RF, CC) renders as a PDF, refused while BiharCabs' GSTIN or the place of
 * supply is missing. Runs against a disposable database whose name ends in _test (migrations 08 to 28):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/gst-document-pdfs.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool, withTransaction } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { processRazorpayEvent } from '../lib/advance-payments';
import { markRefundProcessed } from '../lib/refunds';
import { issuePendingCancellationDocuments, recordCancellationCharge } from '../lib/cancellation-charges';
import { listDocumentsAwaitingPlaceOfSupply, setDocumentPlaceOfSupply } from '../lib/place-of-supply';
import { gstDocumentPdf, taxLines } from '../lib/gst-pdf';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let adminId = 0;
let originalCompany: any;
let originalCities: any;
const GSTIN_BIHAR = '10ABCDE1234F1Z5';      // well-formed test GSTINs, not real registrations
const GSTIN_WEST_BENGAL = '19ABCDE1234F1Z5';
const UNLISTED_CITY = `Docpur${RUN}`;
const ADVANCE_PAISE = 50000;                // ₹500, 18% GST included = ₹76.27

/** A booking whose ₹500 advance is paid through the real webhook handler, issuing its receipt voucher. */
async function paidAdvance(pickupCity: string, customerGstin: string | null = null) {
  const cu = await query(`INSERT INTO crm_customers (phone, full_name, gstin) VALUES ($1, 'Doc Customer', $2) RETURNING id`,
    [`9158${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`, customerGstin]);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status, advance_status, payment_mode)
     VALUES ($1, $2, 'oneway', $3, 'Gaya', 'Main Road', CURRENT_DATE + 3, '10:00', 'sedan', 2500, 2280, 220, 'AWAITING_ADVANCE', 'PENDING', 'ADVANCE_ONLINE')
     RETURNING id, booking_code`,
    [`BC-D${RUN}${seq++}`, cu.rows[0].id, pickupCity]
  );
  const linkId = `plink_d${RUN}${seq++}`;
  await query(
    `INSERT INTO crm_payment_links (booking_id, provider_link_id, reference_id, amount_paise, short_url, status, expire_by)
     VALUES ($1, $2, $2, $3, 'https://rzp.io/test', 'CREATED', CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
    [b.rows[0].id, linkId, ADVANCE_PAISE]
  );
  const paymentId = `pay_d${RUN}${seq++}`;
  await processRazorpayEvent(`evt_d${RUN}${seq++}`, {
    entity: 'event', event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: linkId, amount: ADVANCE_PAISE, amount_paid: ADVANCE_PAISE, status: 'paid' } },
      payment: { entity: { id: paymentId, amount: ADVANCE_PAISE, currency: 'INR', status: 'captured' } },
    },
  });
  const link = (await query(`SELECT * FROM crm_payment_links WHERE provider_link_id = $1`, [linkId])).rows[0];
  assert.ok(link.receipt_voucher_number, 'receipt voucher issued');
  return { bookingId: Number(b.rows[0].id), link, paymentId };
}
/** Refund the whole advance; the refund voucher is issued when Razorpay reports it processed. */
async function refunded(bookingId: number, paymentId: string) {
  const r = await query(
    `INSERT INTO crm_refunds (booking_id, provider_payment_id, amount_paise, status, reason) VALUES ($1, $2, $3, 'PENDING', 'test') RETURNING id`,
    [bookingId, paymentId, ADVANCE_PAISE]
  );
  await withTransaction((c) => markRefundProcessed(c, Number(r.rows[0].id), `rfnd_d${RUN}${seq++}`));
  return (await query(`SELECT * FROM crm_refunds WHERE id = $1`, [r.rows[0].id])).rows[0];
}
/** Keep the whole advance as a cancellation charge and issue its document. */
async function kept(bookingId: number) {
  await withTransaction((c) => recordCancellationCharge(c, bookingId, ADVANCE_PAISE / 100));
  await issuePendingCancellationDocuments();
  return (await query(`SELECT * FROM crm_cancellation_charges WHERE booking_id = $1`, [bookingId])).rows[0];
}
const sum = (d: any) => Math.round((Number(d.cgst_amount) + Number(d.sgst_amount) + Number(d.igst_amount)) * 100) / 100;
/** The document title from the PDF's info dictionary (PDFKit writes it as its own object). */
const pdfTitle = (buf: Buffer) => {
  const s = buf.toString('latin1');
  const ref = s.match(/\/Title (\d+) 0 R/)?.[1];
  const raw = ref ? s.match(new RegExp(`\\n${ref} 0 obj\\n\\(((?:\\\\.|[^\\\\)])*)\\)\\nendobj`))?.[1] : undefined;
  return raw?.replace(/\\([()\\])/g, '$1');
};

before(async () => {
  const s = await getAllSettings(true);
  originalCompany = s.company_billing_info;
  originalCities = s.place_of_supply_cities;
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Doc Tester', 'FINANCE_MANAGER', false) RETURNING id`,
    [`docs-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
});
after(async () => {
  if (originalCompany !== undefined) await updateSetting('company_billing_info', originalCompany);
  if (originalCities !== undefined) await updateSetting('place_of_supply_cities', originalCities);
  await getDbPool().end();
});

describe('receipt vouchers', () => {
  it('pickup in Patna: 18% recorded, split into CGST + SGST', async () => {
    const { link } = await paidAdvance('Patna');
    assert.strictEqual(Number(link.gst_pct), 18);
    assert.strictEqual(Number(link.gst_amount), 76.27);
    assert.strictEqual(link.place_of_supply_code, '10');
    assert.strictEqual(link.place_of_supply_basis, 'PICKUP_CITY');
    assert.ok(Number(link.cgst_amount) > 0 && Number(link.igst_amount) === 0);
    assert.strictEqual(sum(link), 76.27);
  });

  it('customer registered in West Bengal: IGST', async () => {
    const { link } = await paidAdvance('Patna', GSTIN_WEST_BENGAL);
    assert.strictEqual(link.place_of_supply_code, '19');
    assert.strictEqual(Number(link.igst_amount), 76.27);
  });
});

describe('refund vouchers and cancellation charges follow their receipt voucher', () => {
  it('a refund voucher takes the receipt voucher\'s place of supply and splits the GST it reverses', async () => {
    const { bookingId, paymentId } = await paidAdvance('Patna');
    const rf = await refunded(bookingId, paymentId);
    assert.strictEqual(rf.place_of_supply_code, '10');
    assert.strictEqual(rf.place_of_supply_basis, 'RECEIPT_VOUCHER');
    assert.strictEqual(sum(rf), Number(rf.gst_reversed));
  });

  it('a cancellation charge takes its receipt voucher\'s place of supply, at 5%', async () => {
    const { bookingId } = await paidAdvance('Patna', GSTIN_WEST_BENGAL);
    const cc = await kept(bookingId);
    assert.strictEqual(cc.status, 'ISSUED');
    assert.strictEqual(cc.place_of_supply_code, '19');
    assert.strictEqual(cc.place_of_supply_basis, 'RECEIPT_VOUCHER');
    assert.strictEqual(Number(cc.igst_amount), Number(cc.gst_amount));
  });

  it('unlisted city: the voucher waits for finance; choosing its state fills in its refund and cancellation documents', async () => {
    const { bookingId, link, paymentId } = await paidAdvance(UNLISTED_CITY);
    assert.strictEqual(link.place_of_supply_code, null);
    const rf = await refunded(bookingId, paymentId);
    const cc = await kept(bookingId);
    assert.strictEqual(rf.place_of_supply_code, null, 'refund waits for its voucher');
    assert.strictEqual(cc.place_of_supply_code, null, 'cancellation waits for its voucher');
    const waiting = await listDocumentsAwaitingPlaceOfSupply();
    assert.ok(waiting.some((d) => d.kind === 'RV' && d.id === Number(link.id)), 'the voucher is listed');
    assert.ok(!waiting.some((d) => d.kind === 'CC' && d.id === Number(cc.id)), 'its cancellation charge is not listed separately');

    const r = await setDocumentPlaceOfSupply({ kind: 'RV', id: Number(link.id), stateCode: '20', rememberCity: false, adminId });
    assert.strictEqual(r.documentsUpdated, 3, 'voucher, refund and cancellation charge');
    const rf2 = (await query(`SELECT * FROM crm_refunds WHERE id = $1`, [rf.id])).rows[0];
    const cc2 = (await query(`SELECT * FROM crm_cancellation_charges WHERE id = $1`, [cc.id])).rows[0];
    for (const d of [rf2, cc2]) {
      assert.strictEqual(d.place_of_supply_code, '20');
      assert.strictEqual(d.place_of_supply_basis, 'RECEIPT_VOUCHER');
      assert.ok(Number(d.igst_amount) > 0, 'Jharkhand: IGST');
    }
  });

  it('a cancellation charge without a receipt voucher works out its own place of supply', async () => {
    const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Doc Customer') RETURNING id`, [`9157${String(Date.now()).slice(-6)}${seq++}`]);
    const b = await query(
      `INSERT INTO crm_bookings (booking_code, customer_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time, wp_vehicle_code,
         customer_total_fare, driver_payout_amount, commission_amount, booking_status)
       VALUES ($1, $2, 'oneway', 'Gaya', 'Main Road', CURRENT_DATE, '10:00', 'sedan', 2000, 1800, 200, 'CANCELLED') RETURNING id`,
      [`BC-E${RUN}${seq++}`, cu.rows[0].id]
    );
    const cc = await kept(Number(b.rows[0].id));
    assert.strictEqual(cc.receipt_voucher_number, null);
    assert.strictEqual(cc.place_of_supply_code, '10');
    assert.strictEqual(cc.place_of_supply_basis, 'PICKUP_CITY');
  });

  it('refund vouchers cannot be set directly, and an unknown kind is refused', async () => {
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'RF', id: 1, stateCode: '10', rememberCity: false, adminId }), (e: any) => e.status === 400);
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'XX', id: 1, stateCode: '10', rememberCity: false, adminId }), (e: any) => e.status === 400);
  });
});

describe('PDFs', () => {
  it('every document type renders, titled with its number', async () => {
    await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
    try {
      const { bookingId, link, paymentId } = await paidAdvance('Patna');
      const rf = await refunded(bookingId, paymentId);
      const { bookingId: b2 } = await paidAdvance('Patna');
      const cc = await kept(b2);
      const inv = (await query(`SELECT id, invoice_number FROM crm_invoices WHERE place_of_supply_code IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0];
      assert.ok(inv, 'an invoice with a place of supply exists (earlier suites settle trips)');
      for (const [kind, id, title] of [
        ['RV', link.id, `RECEIPT VOUCHER ${link.receipt_voucher_number}`],
        ['RF', rf.id, `REFUND VOUCHER ${rf.refund_voucher_number}`],
        ['CC', cc.id, `TAX INVOICE \\(CANCELLATION CHARGE\\) ${cc.invoice_number}`],
        ['TI', inv.id, `TAX INVOICE ${inv.invoice_number}`],
      ] as const) {
        const pdf = await gstDocumentPdf(kind, Number(id));
        assert.strictEqual(pdf.buffer.subarray(0, 5).toString(), '%PDF-', `${kind} is a PDF`);
        assert.ok(new RegExp(`^${title}$`).test(pdfTitle(pdf.buffer) || ''), `${kind} title: ${pdfTitle(pdf.buffer)}`);
      }
    } finally {
      await updateSetting('company_billing_info', originalCompany);
    }
  });

  it('is refused without BiharCabs\' GSTIN, without a place of supply, or for a missing document', async () => {
    const { link } = await paidAdvance('Patna');
    await updateSetting('company_billing_info', { ...originalCompany, gstin: '' });
    await assert.rejects(gstDocumentPdf('RV', Number(link.id)), /GSTIN is not set/);
    await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
    try {
      const waiting = await paidAdvance(UNLISTED_CITY);
      await assert.rejects(gstDocumentPdf('RV', Number(waiting.link.id)), (e: any) => e.status === 409 && /place of supply/.test(e.message));
      await assert.rejects(gstDocumentPdf('RV', 2_000_000_000), (e: any) => e.status === 404);
      await assert.rejects(gstDocumentPdf('XX' as any, 1), (e: any) => e.status === 400);
    } finally {
      await updateSetting('company_billing_info', originalCompany);
    }
  });

  it('tax lines: CGST + SGST at 9% each for an 18% receipt voucher in Bihar, IGST 18% elsewhere', () => {
    assert.deepStrictEqual(taxLines({ supplier_state_code: '10', place_of_supply_code: '10', cgst_amount: 38.14, sgst_amount: 38.13, igst_amount: 0 }, 18),
      [{ label: 'CGST @ 9%', amount: 38.14 }, { label: 'SGST @ 9%', amount: 38.13 }]);
    assert.deepStrictEqual(taxLines({ supplier_state_code: '10', place_of_supply_code: '19', igst_amount: 76.27 }, 18), [{ label: 'IGST @ 18%', amount: 76.27 }]);
  });
});
