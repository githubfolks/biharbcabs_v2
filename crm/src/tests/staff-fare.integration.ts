/**
 * Staff bookings are priced on the server from the rate card; only the super admin may book a different
 * fare, with a reason. Runs against a disposable database whose name ends in _test (migrations 08 to 20):
 *
 *   DATABASE_URL=postgresql://localhost/biharcabs_crm_test npx tsx --test src/tests/staff-fare.integration.ts
 *
 * The WordPress rate card is simulated in this test only; WhatsApp sends are simulated without a Meta token.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { query, getDbPool } from '../lib/db';
import { createAdminSession, hashPassword, SESSION_COOKIE_NAME } from '../lib/auth';
import { POST as bookingsPOST } from '../app/api/bookings/route';

const dbName = new URL(process.env.DATABASE_URL || 'postgresql://x/none').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run: ${dbName} is not a _test database.`);

const RUN = crypto.randomBytes(3).toString('hex');
let seq = 0;

// ---- Rate card simulation (test only): Patna -> Patna Airport, sedan ₹1,500, 18 km ----
let rateCardDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('/wp-json/biharcabs/v1/quote')) {
    if (rateCardDown) throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    if (body.origin_city === 'Patna' && body.destination_city === 'Patna Airport') {
      return new Response(JSON.stringify({
        success: true,
        route: { origin: 'Patna', destination: 'Patna Airport', distance_km: 18, duration_text: '35 min', is_fixed_tariff: true },
        quotes: [{ vehicle_code: 'sedan', vehicle_name: 'Sedan', vehicle_models: 'Dzire', seating_capacity: 4, luggage_bags: 2, total_fare: 1500, base_fare: 1500, driver_allowance: 0, toll_tax_text: '' }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, code: 'NO_TARIFF', message: 'Please contact us for a custom quote.', quotes: [] }), { status: 404 });
  }
  return realFetch(url, init);
}) as typeof fetch;

const tokens: Record<string, string> = {};
const adminIds: number[] = [];
async function admin(role: string) {
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const r = await query(`INSERT INTO crm_admin_users (email, password_hash, salt, full_name, role, is_active) VALUES ($1, $2, $3, 'Fare Tester', $4, true) RETURNING id`,
    [`fare-${RUN}-${adminIds.length}@example.test`, hash, salt, role]);
  adminIds.push(Number(r.rows[0].id));
  tokens[role] = (await createAdminSession(Number(r.rows[0].id))).token;
}
/** Book as `role` for a fresh customer; returns the response and the customer's phone. */
async function book(role: string, over: Record<string, any> = {}) {
  const phone = `9122${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
  const body = {
    customer_phone: phone, customer_name: 'Fare Customer', trip_type: 'airport', origin_city: 'Patna', destination_city: 'Patna Airport',
    pickup_address: 'Boring Road', pickup_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), pickup_time: '10:00',
    wp_vehicle_code: 'sedan', advance_mode: 'FULL_CASH', auto_broadcast: false, ...over,
  };
  const res = await bookingsPOST(new NextRequest('http://localhost:3001/api/bookings', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${tokens[role]}` }, body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json(), phone };
}
const bookingsFor = async (phone: string) =>
  (await query(`SELECT b.* FROM crm_bookings b JOIN crm_customers c ON c.id = b.customer_id WHERE c.phone = $1`, [phone])).rows;

before(async () => {
  await admin('DISPATCHER');
  await admin('SUPER_ADMIN');
});
after(async () => {
  globalThis.fetch = realFetch;
  await query(`DELETE FROM crm_admin_sessions WHERE user_id = ANY($1)`, [adminIds]);
  await query(`UPDATE crm_admin_users SET is_active = false WHERE id = ANY($1)`, [adminIds]);
  await getDbPool().end();
});

describe('dispatchers book at the rate-card fare', () => {
  it('no fare given: the rate-card fare and route distance are used', async () => {
    const r = await book('DISPATCHER', { distance_km: 999 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const [b] = await bookingsFor(r.phone);
    assert.strictEqual(Number(b.customer_total_fare), 1500);
    assert.strictEqual(Number(b.distance_km), 18, 'distance from the rate card, not the form');
    assert.strictEqual(b.fare_source, 'RATE_CARD');
    assert.strictEqual(Number(b.rate_card_fare), 1500);
    assert.strictEqual(b.fare_override_by, null);
  });

  it('the rate-card fare typed in is fine', async () => {
    const r = await book('DISPATCHER', { customer_total_fare: 1500 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await bookingsFor(r.phone))[0].fare_source, 'RATE_CARD');
  });

  it('a different fare is refused, and nothing is booked', async () => {
    for (const fare of [900, 1501, 25000]) {
      const r = await book('DISPATCHER', { customer_total_fare: fare, fare_override_reason: 'Customer is a friend of the owner' });
      assert.strictEqual(r.status, 403, `fare ${fare}`);
      assert.match(r.json.error, /rate-card fare of ₹1,500/);
      assert.strictEqual((await bookingsFor(r.phone)).length, 0);
    }
  });

  it('a route not on the rate card, or the rate card down: the dispatcher is told to ask the super admin', async () => {
    const unlisted = await book('DISPATCHER', { destination_city: 'Rajgir' });
    assert.strictEqual(unlisted.status, 409);
    assert.match(unlisted.json.error, /not on the rate card.*super admin/);
    assert.strictEqual((await bookingsFor(unlisted.phone)).length, 0);

    rateCardDown = true;
    try {
      const down = await book('DISPATCHER');
      assert.strictEqual(down.status, 409);
      assert.match(down.json.error, /could not be reached/);
    } finally {
      rateCardDown = false;
    }
  });
});

describe('the super admin may book a different fare, with a reason', () => {
  it('records the override, the rate-card fare, who and why', async () => {
    const r = await book('SUPER_ADMIN', { customer_total_fare: 1200, fare_override_reason: 'Corporate contract rate, AIIMS' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const [b] = await bookingsFor(r.phone);
    assert.strictEqual(Number(b.customer_total_fare), 1200);
    assert.strictEqual(b.fare_source, 'OVERRIDE');
    assert.strictEqual(Number(b.rate_card_fare), 1500);
    assert.strictEqual(Number(b.fare_override_by), adminIds[1]);
    assert.strictEqual(b.fare_override_reason, 'Corporate contract rate, AIIMS');
  });

  it('an unlisted route can be booked by the super admin, using the distance given', async () => {
    const r = await book('SUPER_ADMIN', { destination_city: 'Rajgir', customer_total_fare: 2800, distance_km: 100, fare_override_reason: 'Custom quote agreed by phone' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const [b] = await bookingsFor(r.phone);
    assert.strictEqual(b.fare_source, 'OVERRIDE');
    assert.strictEqual(b.rate_card_fare, null);
    assert.strictEqual(Number(b.distance_km), 100);
  });

  it('refuses an override without a reason, a fare that leaves the driver nothing, and a non-numeric fare', async () => {
    const noReason = await book('SUPER_ADMIN', { customer_total_fare: 1200 });
    assert.strictEqual(noReason.status, 400);
    assert.match(noReason.json.error, /needs a reason/);
    const tooLow = await book('SUPER_ADMIN', { customer_total_fare: 5, fare_override_reason: 'Testing a tiny fare' });
    assert.strictEqual(tooLow.status, 400);
    assert.match(tooLow.json.error, /driver would earn nothing/);
    for (const fare of [-100, 'abc']) {
      const bad = await book('SUPER_ADMIN', { customer_total_fare: fare, fare_override_reason: 'Testing a bad fare' });
      assert.strictEqual(bad.status, 400, String(fare));
    }
    for (const r of [noReason, tooLow]) assert.strictEqual((await bookingsFor(r.phone)).length, 0);
  });
});
