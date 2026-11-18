import { NextRequest, NextResponse } from 'next/server';
import { getRazorpayWebhookSecret, verifyRazorpaySignature } from '@/lib/razorpay';
import { processRazorpayEvent } from '@/lib/advance-payments';

export const dynamic = 'force-dynamic';

/**
 * Razorpay webhook (payment_link.paid / payment_link.expired / payment_link.cancelled).
 * The signature is checked on the exact bytes received, before anything is parsed.
 * A 5xx response makes Razorpay retry; 2xx/4xx do not need a retry.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const secret = getRazorpayWebhookSecret();
  if (!secret) {
    console.error('[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET is not set; rejecting all webhook events.');
    return NextResponse.json({ status: 'webhook_not_configured' }, { status: 503 });
  }
  if (!verifyRazorpaySignature(rawBody, req.headers.get('x-razorpay-signature'), secret)) {
    return NextResponse.json({ status: 'invalid_signature' }, { status: 401 });
  }

  const eventId = (req.headers.get('x-razorpay-event-id') || '').trim();
  if (!eventId || eventId.length > 64) {
    return NextResponse.json({ status: 'missing_event_id' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ status: 'invalid_json' }, { status: 400 });
  }

  try {
    const outcome = await processRazorpayEvent(eventId, event);
    return NextResponse.json(outcome);
  } catch (err: any) {
    console.error(`[Razorpay Webhook] Processing failed for event ${eventId}:`, err?.message);
    return NextResponse.json({ status: 'processing_failed' }, { status: 500 });
  }
}
