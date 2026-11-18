/**
 * Advance waiver rules shared by the API and the admin UI. No server-only imports, so client
 * components can use them; the API (advance-payments.ts) is what enforces them.
 */

export const MIN_WAIVER_REASON_LENGTH = 10;

/** Bookings whose advance can still be waived. */
export const WAIVABLE_STATUSES: readonly string[] = ['AWAITING_ADVANCE', 'ADVANCE_LINK_FAILED', 'ADVANCE_EXPIRED'];
