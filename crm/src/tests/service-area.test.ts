import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateServiceCoverage } from '../lib/service-area';
import { ServiceCoverageConfig } from '../lib/settings';

const BIHAR_CONFIG: ServiceCoverageConfig = {
  enabled: true,
  origin_cities: ['Patna', 'Darbhanga', 'Muzaffarpur', 'Gaya'],
  destination_cities: ['Varanasi', 'Ranchi', 'Siliguri'],
  allowed_states: ['Bihar'],
  blocked_routes: ['Patna -> Kathmandu'],
};

test('disabled service coverage allows any origin and destination', () => {
  const res = evaluateServiceCoverage(
    { ...BIHAR_CONFIG, enabled: false },
    { origin: 'London', destination: 'Paris' }
  );
  assert.equal(res.serviceable, true);
  assert.equal(res.code, 'OK');
});

test('allows serviced origin and destination matching allowed state via geocoded display_name', () => {
  const res = evaluateServiceCoverage(BIHAR_CONFIG, {
    origin: 'Darbhanga',
    destination: 'Katihar',
    destinationDisplayName: 'Katihar, Bihar, India',
    supportPhone: '+91 7070992170',
  });
  assert.equal(res.serviceable, true);
  assert.equal(res.code, 'OK');
});

test('allows destination listed in destination_cities outside allowed_states', () => {
  const res = evaluateServiceCoverage(BIHAR_CONFIG, {
    origin: 'Patna',
    destination: 'Varanasi',
    destinationDisplayName: 'Varanasi, Uttar Pradesh, India',
    supportPhone: '+91 7070992170',
  });
  assert.equal(res.serviceable, true);
  assert.equal(res.code, 'OK');
});

test('rejects unserviced destination with clear message and support number', () => {
  const res = evaluateServiceCoverage(BIHAR_CONFIG, {
    origin: 'Patna',
    destination: 'Mumbai',
    destinationDisplayName: 'Mumbai, Maharashtra, India',
    supportPhone: '+91 7070992170',
  });
  assert.equal(res.serviceable, false);
  assert.equal(res.code, 'DESTINATION_NOT_SERVICED');
  assert.match(res.reason || '', /Mumbai/);
  assert.match(res.reason || '', /\+91 7070992170/);
});

test('rejects unserviced origin city', () => {
  const res = evaluateServiceCoverage(BIHAR_CONFIG, {
    origin: 'Jaipur',
    originDisplayName: 'Jaipur, Rajasthan, India',
    supportPhone: '+91 7070992170',
  });
  assert.equal(res.serviceable, false);
  assert.equal(res.code, 'ORIGIN_NOT_SERVICED');
  assert.match(res.reason || '', /Jaipur/);
});

test('rejects explicitly blocked corridor even if cities are allowed', () => {
  const res = evaluateServiceCoverage(
    { ...BIHAR_CONFIG, destination_cities: [...BIHAR_CONFIG.destination_cities, 'Kathmandu'] },
    { origin: 'Patna', destination: 'Kathmandu', supportPhone: '+91 7070992170' }
  );
  assert.equal(res.serviceable, false);
  assert.equal(res.code, 'ROUTE_BLOCKED');
  assert.match(res.reason || '', /Patna.*Kathmandu/);
});
