import crypto from 'crypto';

/**
 * Customer-facing booking codes, e.g. BC-7KQ4MX.
 *
 * Codes were "BC-" + a random 4-digit number: only 9,000 values for a unique column, so as bookings
 * accumulated, inserts increasingly failed on duplicates (about 3.5% of new bookings at ~300 bookings,
 * every second one at ~4,500). Codes are now 6 characters from an alphabet without look-alikes
 * (no 0/O/1/I), about 1.07 billion values, drawn with crypto so they cannot be guessed or counted.
 * Inserts still retry on the rare collision.
 */

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 6;
const MAX_ATTEMPTS = 5;
const UNIQUE_CONSTRAINT = 'crm_bookings_booking_code_key';

export function newBookingCode(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `BC-${code}`;
}

/** Run an INSERT that uses a new booking code, retrying with a fresh code if that code is already taken. */
export async function insertWithBookingCode<T>(insert: (bookingCode: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insert(newBookingCode());
    } catch (err: any) {
      const duplicateCode = err?.code === '23505' && err?.constraint === UNIQUE_CONSTRAINT;
      if (!duplicateCode || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}
