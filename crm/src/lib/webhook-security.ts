import crypto from 'crypto';
import { query } from './db';

/**
 * Meta webhook authentication and duplicate handling.
 *
 * Meta signs each event notification with an HMAC-SHA256 of the payload, keyed with the app's
 * App Secret, sent as "X-Hub-Signature-256: sha256=<signature>". Per Meta's Webhooks guide
 * (developers.facebook.com/docs/graph-api/webhooks/getting-started). The guide does not state the
 * digest encoding; lowercase hex over the raw request body is the standard implementation and is
 * what this checks. Confirm against the first real webhook after configuring the App Secret.
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!appSecret || !signatureHeader) return false;
  const match = signatureHeader.trim().match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/** App Secret from the environment. It is never stored in the database or in git. */
export function getMetaAppSecret(): string {
  return (process.env.META_APP_SECRET || '').trim();
}

/**
 * Record a webhook message id. Returns false if it was already recorded, so a repeat delivery
 * (Meta retries for up to 36 hours) is ignored instead of, say, settling a trip twice.
 */
export async function claimWebhookMessage(messageId: string): Promise<boolean> {
  const res = await query(
    `INSERT INTO crm_webhook_events (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
    [messageId]
  );
  return (res.rowCount ?? 0) > 0;
}
