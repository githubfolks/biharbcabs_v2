import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFuelApiUrl,
  extractFuelPricesFromPayload,
  extractSingleFuelPriceFromPayload,
  todayIstDate,
} from '../lib/fuel-price-sync';

test('extractFuelPricesFromPayload handles RapidAPI nested retailPrice schema', () => {
  const payload = {
    cityId: 'patna',
    fuel: {
      petrol: { retailPrice: 105.18, retailUnit: 'litre' },
      diesel: { retailPrice: 92.04, retailUnit: 'litre' },
      cng: { retailPrice: 89.5, retailUnit: 'kg' },
    },
  };
  const extracted = extractFuelPricesFromPayload(payload);
  assert.deepEqual(extracted, { PETROL: 105.18, DIESEL: 92.04, CNG: 89.5 });
});

test('extractFuelPricesFromPayload handles Zyla / currency-formatted string schema', () => {
  const payload = {
    status: 'success',
    prices: {
      petrol: { price: '₹105.47 /L' },
      diesel: { price: '₹92.32' },
    },
  };
  const extracted = extractFuelPricesFromPayload(payload);
  assert.equal(extracted.CNG, undefined);
  assert.deepEqual(extracted, { PETROL: 105.47, DIESEL: 92.32 });
});

test('extractFuelPricesFromPayload supports explicit dot-paths and rejects garbage/unrealistic numbers', () => {
  const payload = {
    data: {
      p: 106.25,
      d: 0, // invalid (too low)
      c: 'not-a-number',
    },
  };
  const extracted = extractFuelPricesFromPayload(payload, {
    petrol_path: 'data.p',
    diesel_path: 'data.d',
    cng_path: 'data.c',
  });
  assert.deepEqual(extracted, { PETROL: 106.25 });
});

test('buildFuelApiUrl substitutes {state} and {city} templates', () => {
  const url = buildFuelApiUrl({
    enabled: true,
    endpoint_url: 'https://example.com/v1/fuel/{state}/{city}',
    api_key: '',
    api_host: '',
    auth_header: '',
    state: 'Bihar',
    city: 'Patna',
    petrol_path: '',
    diesel_path: '',
    cng_path: '',
  });
  assert.equal(url, 'https://example.com/v1/fuel/bihar/patna');
  assert.match(todayIstDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('extractSingleFuelPriceFromPayload matches target city from IndianAPI array response', () => {
  const payload = [
    { city: 'Agra', price: '101.54', change: '0.00' },
    { city: 'Patna', price: '105.58', change: '0.00' },
  ];
  assert.equal(extractSingleFuelPriceFromPayload(payload, { city: 'patna' }), 105.58);
  assert.equal(extractSingleFuelPriceFromPayload(payload, { city: 'nonexistent' }), null);
});
