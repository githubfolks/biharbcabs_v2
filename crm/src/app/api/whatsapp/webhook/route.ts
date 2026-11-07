import { NextRequest, NextResponse } from 'next/server';
import { getMetaWhatsAppConfig } from '@/lib/settings';
import { parseIncomingWebhook, logWhatsAppMessage } from '@/lib/whatsapp';
import { processIncomingWhatsAppMessage } from '@/lib/whatsapp-bot';
import { claimWebhookMessage, getMetaAppSecret, verifyMetaSignature } from '@/lib/webhook-security';

export const dynamic = 'force-dynamic';

/**
 * Meta WhatsApp Webhook Verification (GET)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    const config = await getMetaWhatsAppConfig();

    if (mode === 'subscribe' && token === config.webhook_verify_token) {
      console.log('[WhatsApp Webhook] Verification successful');
      return new NextResponse(challenge, { status: 200 });
    }

    return new NextResponse('Forbidden: Invalid verify token', { status: 403 });
  } catch (err: any) {
    return new NextResponse(err.message, { status: 500 });
  }
}

/**
 * Meta WhatsApp Event Notification (POST)
 */
export async function POST(req: NextRequest) {
  // 1. Authenticate before reading anything: the signature covers the exact bytes Meta sent.
  const rawBody = await req.text();
  const appSecret = getMetaAppSecret();
  if (!appSecret) {
    console.error('[WhatsApp Webhook] META_APP_SECRET is not set; rejecting all webhook events.');
    return NextResponse.json({ status: 'webhook_not_configured' }, { status: 503 });
  }
  if (!verifyMetaSignature(rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
    return NextResponse.json({ status: 'invalid_signature' }, { status: 401 });
  }

  try {
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ status: 'invalid_json' }, { status: 400 });
    }
    const parsed = parseIncomingWebhook(body);

    if (!parsed || !parsed.fromPhone) {
      // Return 200 immediately to acknowledge Meta webhooks
      return NextResponse.json({ status: 'ignored_or_no_message' });
    }

    // 2. Process each message once. Meta retries deliveries, and a repeated "Complete Trip"
    //    must not settle a trip twice. A message is claimed before processing and never
    //    reprocessed, even if processing fails part-way.
    if (!parsed.messageId) {
      return NextResponse.json({ status: 'ignored_no_message_id' });
    }
    if (!(await claimWebhookMessage(parsed.messageId))) {
      return NextResponse.json({ status: 'duplicate_ignored' });
    }

    await logWhatsAppMessage(
      'INBOUND',
      parsed.fromPhone,
      parsed.messageType || 'unknown',
      parsed.rawPayload,
      'RECEIVED'
    );

    // Route event through the BiharCabs WhatsApp State Machine
    await processIncomingWhatsAppMessage({
      fromPhone: parsed.fromPhone,
      customerName: parsed.customerName,
      text: parsed.text,
      buttonId: parsed.buttonId,
      buttonText: parsed.buttonText,
    });

    return NextResponse.json({ status: 'success' });
  } catch (err: any) {
    console.error('[WhatsApp Webhook Handler Error]:', err);
    return NextResponse.json({ status: 'error', error: err.message }, { status: 200 });
  }
}
