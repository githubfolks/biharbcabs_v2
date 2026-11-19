/**
 * GST document numbers per BiharCabs' CA: one consecutive series per document type, at most 16
 * characters (Rule 46(b), CGST Rules), restarting at 000001 every 1 April; ride invoices numbered in
 * their own series; the kept-advance cancellation charge taxed at 5%. Runs against a disposable database
 * whose name ends in _test (migrations 08 to 26):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/gst-numbering.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool, withTransaction } from '../lib/db';
import { financialYearCode, nextDocumentNumber, DOCUMENT_SERIES } from '../lib/gst-documents';
import { getCancellationChargeGstPct } from '../lib/cancellation-charges';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';
import { completeTripAndSettle } from '../lib/billing';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
// Financial years far in the future, reset before each run, so these tests own their counters.
const TEST_FY_DATE = (y: number) => new Date(`${y}-06-15T12:00:00+05:30`);
const TEST_FYS = ['9091', '9192', '9293'];

before(async () => {
  await query(`DELETE FROM crm_document_counters WHERE financial_year = ANY($1)`, [TEST_FYS]);
});
after(async () => {
  await query(`DELETE FROM crm_document_counters WHERE financial_year = ANY($1)`, [TEST_FYS]);
  await getDbPool().end();
});

const issue = (series: (typeof DOCUMENT_SERIES)[number], at: Date) => withTransaction((c) => nextDocumentNumber(c, series, at));

describe('series format and order', () => {
  it('numbers are <series><financial year><6 digits>, at most 16 characters, and consecutive', async () => {
    const at = TEST_FY_DATE(2090);
    const a = await issue('TI', at);
    const b = await issue('TI', at);
    assert.strictEqual(a, 'TI9091000001');
    assert.strictEqual(b, 'TI9091000002');
    assert.ok(a.length <= 16);
  });

  it('each series counts on its own', async () => {
    const at = TEST_FY_DATE(2090);
    assert.strictEqual(await issue('RV', at), 'RV9091000001');
    assert.strictEqual(await issue('RF', at), 'RF9091000001');
    assert.strictEqual(await issue('CC', at), 'CC9091000001');
    assert.strictEqual(await issue('TI', at), 'TI9091000003', 'TI continues after the others');
  });

  it('a transaction that fails gives its number back, so there is no gap', async () => {
    const at = TEST_FY_DATE(2091);
    assert.strictEqual(await issue('RV', at), 'RV9192000001');
    await assert.rejects(withTransaction(async (c) => {
      await nextDocumentNumber(c, 'RV', at);
      throw new Error('document not saved');
    }), /document not saved/);
    assert.strictEqual(await issue('RV', at), 'RV9192000002');
  });

  it('documents issued at the same moment get distinct, consecutive numbers', async () => {
    const at = TEST_FY_DATE(2092);
    const numbers = await Promise.all(Array.from({ length: 10 }, () => issue('RF', at)));
    assert.deepStrictEqual([...numbers].sort(), Array.from({ length: 10 }, (_, i) => `RF9293${String(i + 1).padStart(6, '0')}`));
  });

  it('an unknown series is refused', async () => {
    await assert.rejects(withTransaction((c) => nextDocumentNumber(c, 'XX' as any, new Date())), /Unknown document series/);
  });
});

describe('restart every 1 April', () => {
  it('the financial year changes at midnight India time on 1 April', () => {
    assert.strictEqual(financialYearCode(new Date('2027-03-31T23:59:59+05:30')), '2627');
    assert.strictEqual(financialYearCode(new Date('2027-04-01T00:00:00+05:30')), '2728');
  });

  it('the new year starts again at 000001 while the old year keeps its count', async () => {
    await query(`DELETE FROM crm_document_counters WHERE financial_year = ANY($1)`, [['9091']]);
    const lastYear = new Date('2091-03-31T23:00:00+05:30'); // FY 2090-91
    const newYear = new Date('2091-04-01T00:30:00+05:30');  // FY 2091-92
    await query(`DELETE FROM crm_document_counters WHERE series = 'CC' AND financial_year = '9192'`);
    assert.strictEqual(await issue('CC', lastYear), 'CC9091000001');
    assert.strictEqual(await issue('CC', lastYear), 'CC9091000002');
    assert.strictEqual(await issue('CC', newYear), 'CC9192000001');
    assert.strictEqual(await issue('CC', lastYear), 'CC9091000003', 'a late document for last year continues its series');
  });
});

describe('ride invoices', () => {
  it('settling trips issues consecutive TI numbers for the current financial year', async () => {
    const fy = financialYearCode(new Date());
    const phone = `9163${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
    const d = await query(
      `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating, total_trips_completed, security_reserve_balance)
       VALUES ($1, $1, 'Numbering Driver', 'Patna', 'APPROVED_ACTIVE', 4.5, 10, 100000) RETURNING id`, [phone]);
    const cu = await query(`INSERT INTO crm_customers (phone, full_name) VALUES ($1, 'Numbering Customer') RETURNING id`, [`9162${String(Date.now()).slice(-6)}${seq++}`]);
    const s = await calculateRideSplitWithTaxes(2000);
    const numbers: string[] = [];
    for (let i = 0; i < 2; i++) {
      const b = await query(
        `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, pickup_address, pickup_date, pickup_time,
           wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status)
         VALUES ($1, $2, $3, 'oneway', 'Patna', 'Main Road', CURRENT_DATE, '10:00', 'sedan', 2000, $4, $5, 'TRIP_IN_PROGRESS') RETURNING id`,
        [`BC-N${RUN}${seq++}`, cu.rows[0].id, d.rows[0].id, s.driverGrossEarnings, s.totalCompanyDuesZ]
      );
      const r = await completeTripAndSettle({ bookingId: Number(b.rows[0].id), cashCollectedByDriver: 2000 });
      numbers.push(r.invoiceNumber);
      const stored = (await query(`SELECT invoice_number FROM crm_invoices WHERE booking_id = $1`, [b.rows[0].id])).rows[0];
      assert.strictEqual(stored.invoice_number, r.invoiceNumber);
    }
    for (const n of numbers) assert.match(n, new RegExp(`^TI${fy}\\d{6}$`));
    assert.strictEqual(Number(numbers[1].slice(-6)), Number(numbers[0].slice(-6)) + 1, 'consecutive');
  });
});

describe('cancellation charge rate', () => {
  it('migration 26 sets the kept-advance cancellation charge to 5% (per CA)', async () => {
    assert.strictEqual(await getCancellationChargeGstPct(), 5);
  });
});
