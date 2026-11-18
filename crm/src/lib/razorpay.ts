import crypto from 'crypto';

/**
 * Razorpay Payment Links and webhook verification.
 *
 * Per Razorpay's docs (razorpay.com/docs/api/payments/payment-links/create-standard and
 * razorpay.com/docs/webhooks/validate-test):
 * - POST https://api.razorpay.com/v1/payment_links with HTTP Basic auth (key id : key secret).
 * - amount is in paise (minimum 100); reference_id is unique per link, at most 40 characters;
 *   expire_by is a Unix time in seconds, at least 15 minutes ahead.
 * - Webhooks carry X-Razorpay-Signature: hex HMAC-SHA256 of the raw request body, keyed with the
 *   webhook secret, and x-razorpay-event-id, unique per event, for de-duplication.
 */

const API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;

interface RazorpayKeys {
  keyId: string;
  keySecret: string;
}

function getApiKeys(): RazorpayKeys {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.');
  }
  return { keyId, keySecret };
}

/** Webhook secret from the environment. It is never stored in the database or in git. */
export function getRazorpayWebhookSecret(): string {
  return (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
}

export function verifyRazorpaySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!secret || !signatureHeader) return false;
  const signature = signatureHeader.trim();
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export interface CreatePaymentLinkInput {
  amountPaise: number;
  referenceId: string;
  description: string;
  expireBy: Date;
  customer: { name?: string; contact?: string };
  notes?: Record<string, string>;
}

export interface CreatedPaymentLink {
  id: string;
  shortUrl: string;
  status: string;
}

export async function createPaymentLink(input: CreatePaymentLinkInput): Promise<CreatedPaymentLink> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
    throw new Error(`Invalid payment link amount: ${input.amountPaise} paise.`);
  }
  if (!input.referenceId || input.referenceId.length > 40) {
    throw new Error('Payment link reference_id must be 1 to 40 characters.');
  }
  const { keyId, keySecret } = getApiKeys();

  const body = {
    amount: input.amountPaise,
    currency: 'INR',
    reference_id: input.referenceId,
    description: input.description.slice(0, 2048),
    expire_by: Math.floor(input.expireBy.getTime() / 1000),
    customer: input.customer,
    // The customer gets the link on WhatsApp from us, so Razorpay does not also send SMS or email.
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: input.notes || {},
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(`Razorpay request failed: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}`);
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Handled below as an invalid response.
  }
  if (!res.ok) {
    const reason = data?.error?.description || `HTTP ${res.status}`;
    throw new Error(`Razorpay refused the payment link: ${reason}`);
  }
  if (!data || typeof data.id !== 'string' || !data.id.startsWith('plink_') || typeof data.short_url !== 'string') {
    throw new Error('Razorpay returned an invalid payment link response.');
  }
  return { id: data.id, shortUrl: data.short_url, status: String(data.status || 'created') };
}
