/**
 * Place of supply and the CGST/SGST/IGST split on ride invoices, per BiharCabs' CA (Rule 46, CGST Rules;
 * Section 12(9), IGST Act): a registered customer's state from their GSTIN, otherwise the pickup city's
 * state from place_of_supply_cities; CGST + SGST within Bihar, IGST otherwise; nothing guessed. Runs
 * against a disposable database whose name ends in _test (migrations 08 to 27):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/place-of-supply.integration.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { query, getDbPool } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { getAllSettings, updateSetting } from '../lib/settings';
import { stateCodeFromGstin } from '../lib/gst-states';
import {
  listDocumentsAwaitingPlaceOfSupply, resolvePlaceOfSupply, setDocumentPlaceOfSupply, splitGst, supplierStateCode,
} from '../lib/place-of-supply';
import { gstDocumentPdf, taxLines } from '../lib/gst-pdf';
import { calculateRideSplitWithTaxes } from '../lib/dispatch-engine';
import { completeTripAndSettle } from '../lib/billing';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;
let adminId = 0;
let driverId = 0;
let originalCompany: any;
let originalCities: any;
// Well-formed test GSTINs (state code, PAN pattern, entity, Z, check character). Not real registrations.
const GSTIN_BIHAR = '10ABCDE1234F1Z5';
const GSTIN_WEST_BENGAL = '19ABCDE1234F1Z5';
const UNLISTED_CITY = `Testpur${RUN}`;

async function settledInvoice(pickupCity: string, customerGstin: string | null = null) {
  const cu = await query(`INSERT INTO crm_customers (phone, full_name, gstin) VALUES ($1, 'POS Customer', $2) RETURNING id`,
    [`9160${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`, customerGstin]);
  const s = await calculateRideSplitWithTaxes(2100);
  const b = await query(
    `INSERT INTO crm_bookings (booking_code, customer_id, assigned_driver_id, trip_type, origin_city, destination_city, pickup_address, pickup_date, pickup_time,
       wp_vehicle_code, customer_total_fare, driver_payout_amount, commission_amount, booking_status)
     VALUES ($1, $2, $3, 'oneway', $4, 'Gaya', 'Main Road', CURRENT_DATE, '10:00', 'sedan', 2100, $5, $6, 'TRIP_IN_PROGRESS') RETURNING id`,
    [`BC-P${RUN}${seq++}`, cu.rows[0].id, driverId, pickupCity, s.driverGrossEarnings, s.totalCompanyDuesZ]
  );
  await completeTripAndSettle({ bookingId: Number(b.rows[0].id), cashCollectedByDriver: 2100 });
  return (await query(`SELECT * FROM crm_invoices WHERE booking_id = $1`, [b.rows[0].id])).rows[0];
}
const sumParts = (i: any) => Math.round((Number(i.cgst_amount) + Number(i.sgst_amount) + Number(i.igst_amount)) * 100) / 100;

before(async () => {
  const settings = await getAllSettings(true);
  originalCompany = settings.company_billing_info;
  originalCities = settings.place_of_supply_cities;
  assert.strictEqual(originalCompany.state_code, '10', 'migration 27 sets BiharCabs\' state');
  assert.strictEqual(originalCities.patna, '10', 'migration 27 lists Patna');
  const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
  adminId = Number((await query(
    `INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'POS Tester', 'FINANCE_MANAGER', false) RETURNING id`,
    [`pos-${RUN}@example.test`, hash, salt]
  )).rows[0].id);
  const phone = `9159${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  driverId = Number((await query(
    `INSERT INTO crm_drivers (phone, whatsapp_phone, full_name, base_city, onboarding_status, rating, total_trips_completed, security_reserve_balance)
     VALUES ($1, $1, 'POS Driver', 'Patna', 'APPROVED_ACTIVE', 4.5, 10, 100000) RETURNING id`, [phone]
  )).rows[0].id);
});
after(async () => {
  if (originalCompany !== undefined) await updateSetting('company_billing_info', originalCompany);
  if (originalCities !== undefined) await updateSetting('place_of_supply_cities', originalCities);
  await getDbPool().end();
});

describe('rules', () => {
  it('reads the state from a well-formed GSTIN only', () => {
    assert.strictEqual(stateCodeFromGstin(GSTIN_BIHAR), '10');
    assert.strictEqual(stateCodeFromGstin(' 19abcde1234f1z5 '), '19', 'trimmed and upper-cased');
    assert.strictEqual(stateCodeFromGstin('28ABCDE1234F1Z5'), null, 'code 28 is no longer listed');
    assert.strictEqual(stateCodeFromGstin('10ABCDE1234F1X5'), null, 'the 14th character must be Z');
    assert.strictEqual(stateCodeFromGstin('10ABCDE1234'), null);
  });

  it('CGST and SGST are half each and always add up to the tax; IGST is the whole tax', () => {
    assert.deepStrictEqual(splitGst(100, '10', '10'), { supplyType: 'INTRA_STATE', cgst: 50, sgst: 50, igst: 0 });
    const odd = splitGst(23.81, '10', '10');
    assert.strictEqual(Math.round((odd.cgst + odd.sgst) * 100) / 100, 23.81);
    assert.deepStrictEqual(splitGst(23.81, '10', '19'), { supplyType: 'INTER_STATE', cgst: 0, sgst: 0, igst: 23.81 });
  });

  it('registered customer: the state in their GSTIN, wherever the pickup is', async () => {
    assert.deepStrictEqual(await resolvePlaceOfSupply({ customerGstin: GSTIN_WEST_BENGAL, pickupCity: 'Patna' }), { code: '19', basis: 'RECIPIENT_GSTIN' });
    assert.strictEqual(await resolvePlaceOfSupply({ customerGstin: 'not-a-gstin', pickupCity: 'Patna' }), null, 'a malformed GSTIN is not ignored');
  });

  it('anyone else: the pickup city\'s state; an unlisted city is not guessed', async () => {
    assert.deepStrictEqual(await resolvePlaceOfSupply({ customerGstin: null, pickupCity: 'Patna' }), { code: '10', basis: 'PICKUP_CITY' });
    assert.deepStrictEqual(await resolvePlaceOfSupply({ customerGstin: '', pickupCity: ' PATNA, Bihar ' }), { code: '10', basis: 'PICKUP_CITY' });
    assert.strictEqual(await resolvePlaceOfSupply({ customerGstin: null, pickupCity: UNLISTED_CITY }), null);
  });

  it('BiharCabs\' state comes from its GSTIN once set, and a mismatch is refused', async () => {
    assert.strictEqual(await supplierStateCode(), '10');
    try {
      await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
      assert.strictEqual(await supplierStateCode(), '10');
      await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_WEST_BENGAL });
      await assert.rejects(supplierStateCode(), /does not match/);
      await updateSetting('company_billing_info', { ...originalCompany, gstin: 'bad' });
      await assert.rejects(supplierStateCode(), /not a valid GSTIN/);
    } finally {
      await updateSetting('company_billing_info', originalCompany);
    }
  });
});

describe('ride invoices at settlement', () => {
  it('pickup in Patna, unregistered customer: CGST + SGST', async () => {
    const inv = await settledInvoice('Patna');
    assert.strictEqual(inv.place_of_supply_code, '10');
    assert.strictEqual(inv.place_of_supply_basis, 'PICKUP_CITY');
    assert.strictEqual(inv.supplier_state_code, '10');
    assert.ok(Number(inv.cgst_amount) > 0 && Number(inv.sgst_amount) > 0);
    assert.strictEqual(Number(inv.igst_amount), 0);
    assert.strictEqual(sumParts(inv), Number(inv.tax_amount));
  });

  it('customer registered in West Bengal: IGST, though picked up in Patna', async () => {
    const inv = await settledInvoice('Patna', GSTIN_WEST_BENGAL);
    assert.strictEqual(inv.place_of_supply_code, '19');
    assert.strictEqual(inv.place_of_supply_basis, 'RECIPIENT_GSTIN');
    assert.strictEqual(Number(inv.igst_amount), Number(inv.tax_amount));
    assert.strictEqual(Number(inv.cgst_amount) + Number(inv.sgst_amount), 0);
  });

  it('unlisted pickup city: the trip is settled and the invoice numbered, but it waits for staff', async () => {
    const inv = await settledInvoice(UNLISTED_CITY);
    assert.match(inv.invoice_number, /^TI\d{10}$/);
    assert.strictEqual(inv.place_of_supply_code, null);
    assert.strictEqual(inv.cgst_amount, null);
    assert.ok((await listDocumentsAwaitingPlaceOfSupply()).some((w) => w.kind === 'TI' && w.id === Number(inv.id)));
  });
});

describe('staff choose the place of supply', () => {
  it('sets the split, records who, and can remember the city for later rides', async () => {
    const city = `Siliguri${RUN}`;
    const inv = await settledInvoice(city);
    const r = await setDocumentPlaceOfSupply({ kind: 'TI', id: Number(inv.id), stateCode: '19', rememberCity: true, adminId });
    assert.strictEqual(r.split.supplyType, 'INTER_STATE');
    assert.strictEqual(r.cityRemembered, true);
    const after = (await query(`SELECT * FROM crm_invoices WHERE id = $1`, [inv.id])).rows[0];
    assert.strictEqual(after.place_of_supply_basis, 'STAFF');
    assert.strictEqual(Number(after.place_of_supply_set_by), adminId);
    assert.strictEqual(Number(after.igst_amount), Number(after.tax_amount));
    assert.ok(!(await listDocumentsAwaitingPlaceOfSupply()).some((w) => w.kind === 'TI' && w.id === Number(inv.id)));

    const next = await settledInvoice(city);
    assert.strictEqual(next.place_of_supply_code, '19', 'the next ride from that city is worked out');
    assert.strictEqual(next.place_of_supply_basis, 'PICKUP_CITY');
  });

  it('a set place of supply is never changed, and a listed city is never overwritten', async () => {
    const inv = await settledInvoice(UNLISTED_CITY);
    await setDocumentPlaceOfSupply({ kind: 'TI', id: Number(inv.id), stateCode: '10', rememberCity: false, adminId });
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'TI', id: Number(inv.id), stateCode: '19', rememberCity: false, adminId }), (e: any) => e.status === 409);
    const done = await settledInvoice('Patna');
    await query(`UPDATE crm_invoices SET place_of_supply_code = NULL WHERE id = $1`, [done.id]);
    const r = await setDocumentPlaceOfSupply({ kind: 'TI', id: Number(done.id), stateCode: '19', rememberCity: true, adminId });
    assert.strictEqual(r.cityRemembered, false);
    assert.strictEqual((await getAllSettings(true)).place_of_supply_cities.patna, '10', 'Patna stays Bihar');
  });

  it('an unknown state, a bad id or a missing invoice is refused', async () => {
    const inv = await settledInvoice(UNLISTED_CITY);
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'TI', id: Number(inv.id), stateCode: '28', rememberCity: false, adminId }), (e: any) => e.status === 400);
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'TI', id: -1, stateCode: '10', rememberCity: false, adminId }), (e: any) => e.status === 400);
    await assert.rejects(setDocumentPlaceOfSupply({ kind: 'TI', id: 2_000_000_000, stateCode: '10', rememberCity: false, adminId }), (e: any) => e.status === 404);
  });
});

describe('invoice PDF', () => {
  it('shows CGST + SGST at 2.5% each within Bihar, IGST at 5% otherwise', () => {
    assert.deepStrictEqual(taxLines({ supplier_state_code: '10', place_of_supply_code: '10', cgst_amount: 50, sgst_amount: 50, igst_amount: 0 }, 5),
      [{ label: 'CGST @ 2.5%', amount: 50 }, { label: 'SGST @ 2.5%', amount: 50 }]);
    assert.deepStrictEqual(taxLines({ supplier_state_code: '10', place_of_supply_code: '19', cgst_amount: 0, sgst_amount: 0, igst_amount: 100 }, 5),
      [{ label: 'IGST @ 5%', amount: 100 }]);
    assert.throws(() => taxLines({ supplier_state_code: null, place_of_supply_code: null }, 5), /place of supply is not set/);
  });

  it('is refused without BiharCabs\' GSTIN or a place of supply, and produced once both are set', async () => {
    try {
      const ready = await settledInvoice('Patna');
      await updateSetting('company_billing_info', { ...originalCompany, gstin: '' });
      await assert.rejects(gstDocumentPdf('TI', Number(ready.id)), /GSTIN is not set/);
      await updateSetting('company_billing_info', { ...originalCompany, gstin: GSTIN_BIHAR });
      const waiting = await settledInvoice(UNLISTED_CITY);
      await assert.rejects(gstDocumentPdf('TI', Number(waiting.id)), /place of supply is not set/);
      const pdf = await gstDocumentPdf('TI', Number(ready.id));
      assert.strictEqual(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.buffer.length > 1000, 'a PDF was produced');
    } finally {
      await updateSetting('company_billing_info', originalCompany);
    }
  });
});
