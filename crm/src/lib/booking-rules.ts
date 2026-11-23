/**
 * Shared booking status rules (safe to import in both server and client components).
 */

/** Bookings that can still be cancelled (before the trip starts). */
export const CANCELLABLE_STATUSES: readonly string[] = [
  'CONFIRMED_AWAITING_DRIVER',
  'AWAITING_DRIVER',
  'ESCALATED_NO_DRIVER',
  'DRIVER_ASSIGNED',
];

export const MIN_OVERRIDE_REASON_LENGTH = 10;

export const BOOKING_TYPES = ['OUTSTATION', 'LOCAL', 'RENTAL'] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

export const CAB_CATEGORIES = ['MICRO', 'MINI', 'SEDAN', 'PRIME_SEDAN', 'SUV', 'LUX', 'BIKE'] as const;
export type CabCategory = (typeof CAB_CATEGORIES)[number];

export const FUEL_TYPES = ['PETROL', 'CNG', 'DIESEL'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
