import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FounderDigestConfig,
  formatFounderDigestMessage,
  getIstClock,
  resolveDueDigestSlot,
} from '../lib/founder-digest';

const baseConfig: FounderDigestConfig = {
  enabled: true,
  phones: ['917070992170'],
  morning_hour_ist: 8,
  evening_hour_ist: 20,
  last_morning_sent_date: null,
  last_evening_sent_date: null,
};

test('resolveDueDigestSlot fires MORNING at 8 AM IST and EVENING at 8 PM IST, once per day', () => {
  // 07:30 IST -> too early
  assert.equal(
    resolveDueDigestSlot(baseConfig, getIstClock(new Date('2026-11-26T07:30:00+05:30'))),
    null
  );

  // 08:05 IST -> MORNING due
  assert.equal(
    resolveDueDigestSlot(baseConfig, getIstClock(new Date('2026-11-26T08:05:00+05:30'))),
    'MORNING'
  );

  // 08:15 IST after MORNING already sent today -> null (idempotent)
  assert.equal(
    resolveDueDigestSlot(
      { ...baseConfig, last_morning_sent_date: '2026-11-26' },
      getIstClock(new Date('2026-11-26T08:15:00+05:30'))
    ),
    null
  );

  // 20:00 IST -> EVENING due even if MORNING was already sent
  assert.equal(
    resolveDueDigestSlot(
      { ...baseConfig, last_morning_sent_date: '2026-11-26' },
      getIstClock(new Date('2026-11-26T20:00:00+05:30'))
    ),
    'EVENING'
  );

  // 20:30 IST after EVENING already sent today -> null (idempotent)
  assert.equal(
    resolveDueDigestSlot(
      { ...baseConfig, last_morning_sent_date: '2026-11-26', last_evening_sent_date: '2026-11-26' },
      getIstClock(new Date('2026-11-26T20:30:00+05:30'))
    ),
    null
  );

  // Disabled -> always null
  assert.equal(
    resolveDueDigestSlot(
      { ...baseConfig, enabled: false },
      getIstClock(new Date('2026-11-26T20:05:00+05:30'))
    ),
    null
  );
});

test('formatFounderDigestMessage renders distinct 8 AM and 8 PM headers with metrics', () => {
  const morningMsg = formatFounderDigestMessage({
    slot: 'MORNING',
    periodLabel: 'Yesterday (2026-11-25)',
    periodDate: '2026-11-25',
    upcomingLabel: 'Today (2026-11-26)',
    upcomingDate: '2026-11-26',
    totalBookings: 12,
    completedRides: 10,
    activeOrAssignedRides: 1,
    unassignedNow: 0,
    cancelledRides: 1,
    gmv: 28500,
    gstLiability: 1850,
    netPlatformRevenue: 3100,
    topCity: 'Patna',
    upcomingPickupsCount: 2,
    upcomingBookings: [
      { bookingCode: 'BC-1001', pickupTime: '09:30', originCity: 'Patna', destinationCity: 'Darbhanga', customerName: 'Amit', driverName: 'Suresh', bookingStatus: 'DRIVER_ASSIGNED' },
      { bookingCode: 'BC-1002', pickupTime: '14:00', originCity: 'Katihar', destinationCity: 'Purnia', customerName: 'Neha', driverName: null, bookingStatus: 'AWAITING_DRIVER' },
    ],
    overdueDuesTotal: 1200,
    driversOwingCount: 2,
    expiringDocsCount: 1,
    openFailedMessages: 0,
  });
  assert.match(morningMsg, /Morning Founder Digest \(8:00 AM\)/);
  assert.match(morningMsg, /Patna/);
  assert.match(morningMsg, /28,500\.00/);
  assert.match(morningMsg, /09:30 #BC-1001.*Driver: Suresh/);
  assert.match(morningMsg, /14:00 #BC-1002.*⚠️ UNASSIGNED/);

  const eveningMsg = formatFounderDigestMessage({
    slot: 'EVENING',
    periodLabel: 'Today so far (2026-11-26)',
    periodDate: '2026-11-26',
    upcomingLabel: 'Tomorrow (2026-11-27)',
    upcomingDate: '2026-11-27',
    totalBookings: 9,
    completedRides: 6,
    activeOrAssignedRides: 2,
    unassignedNow: 1,
    cancelledRides: 0,
    gmv: 14200,
    gstLiability: 920,
    netPlatformRevenue: 1650,
    topCity: 'Katihar',
    upcomingPickupsCount: 1,
    upcomingBookings: [
      { bookingCode: 'BC-2001', pickupTime: '06:00', originCity: 'Patna', destinationCity: 'Patna Airport', customerName: 'Vikram', driverName: 'Ramesh', bookingStatus: 'DRIVER_ASSIGNED' },
    ],
    overdueDuesTotal: 800,
    driversOwingCount: 1,
    expiringDocsCount: 0,
    openFailedMessages: 2,
  });
  assert.match(eveningMsg, /Evening Founder Digest \(8:00 PM\)/);
  assert.match(eveningMsg, /Open Failed WA Messages: 2/);
  assert.match(eveningMsg, /06:00 #BC-2001.*Patna Airport/);
});
