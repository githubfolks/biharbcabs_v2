import crypto from 'crypto';

/**
 * Authentication for the scheduled-job endpoints (/api/dispatch/cron and /api/dispatch/cron/daily).
 *
 * These endpoints send WhatsApp messages and suspend drivers, so only the scheduler may call them.
 * The scheduler sends "Authorization: Bearer <CRON_SECRET>". The secret comes from the environment,
 * never from git or the database.
 */
export type CronAuthResult = 'ok' | 'not_configured' | 'unauthorized';

export function getCronSecret(): string {
  return (process.env.CRON_SECRET || '').trim();
}

export function checkCronAuthorization(authorizationHeader: string | null, secret: string): CronAuthResult {
  if (!secret) return 'not_configured';
  const match = (authorizationHeader || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return 'unauthorized';
  // Compare fixed-length digests so the check takes the same time whatever the length of the guess.
  const given = crypto.createHash('sha256').update(match[1].trim(), 'utf8').digest();
  const expected = crypto.createHash('sha256').update(secret, 'utf8').digest();
  return crypto.timingSafeEqual(given, expected) ? 'ok' : 'unauthorized';
}
