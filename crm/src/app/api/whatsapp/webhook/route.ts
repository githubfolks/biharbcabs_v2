import { NextRequest, NextResponse } from 'next/server';
import { getMetaWhatsAppConfig } from '@/lib/settings';
import { parseIncomingWebhookMessages, logWhatsAppMessage, sendWhatsAppText } from '@/lib/whatsapp';
import { processIncomingWhatsAppMessage } from '@/lib/whatsapp-bot';
import { claimWebhookMessage, getMetaAppSecret, verifyMetaSignature } from '@/lib/webhook-security';
import { notifyAdmins, recordNotificationFailure, resolveTemplateButton } from '@/lib/wa-notify';

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
    console.error('[WhatsApp Webhook GET] Failed:', err);
    return new NextResponse('Internal server error', { status: 500 });
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

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ status: 'invalid_json' }, { status: 400 });
  }

  const messages = parseIncomingWebhookMessages(body);
  if (messages.length === 0) {
    return NextResponse.json({ status: 'ignored_or_no_message' });
  }

  let processed = 0;
  let duplicates = 0;
  let failed = 0;

  for (const parsed of messages) {
    if (!parsed.fromPhone || !parsed.messageId) continue;

    // 2. Process each message once. Meta retries deliveries, and a repeated "Complete Trip"
    //    must not settle a trip twice. A message is claimed before processing and never
    //    reprocessed, even if processing fails part-way.
    try {
      if (!(await claimWebhookMessage(parsed.messageId))) {
        duplicates++;
        continue;
      }

      await logWhatsAppMessage(
        'INBOUND',
        parsed.fromPhone,
        parsed.messageType || 'unknown',
        parsed.rawPayload,
        'RECEIVED'
      );

      // A tap on a template's quick-reply button arrives with the button label; map it back to its booking.
      let buttonId = parsed.buttonId;
      if (parsed.messageType === 'button') {
        buttonId = (await resolveTemplateButton(parsed.contextId, parsed.buttonText ?? parsed.buttonId, parsed.fromPhone)) ?? parsed.buttonId;
      }

      // Route event through the BiharCabs WhatsApp State Machine
      await processIncomingWhatsAppMessage({
        fromPhone: parsed.fromPhone,
        customerName: parsed.customerName,
        text: parsed.text,
        buttonId,
        buttonText: parsed.buttonText,
        mediaId: parsed.mediaId,
        mediaMime: parsed.mediaMime,
      });
      processed++;
    } catch (err: any) {
      failed++;
      const errMsg = err?.message || String(err);
      console.error(`[WhatsApp Webhook Handler Error] msg=${parsed.messageId} phone=${parsed.fromPhone}:`, err);

      // Record failure, tell the sender to retry / call support, and alert admins so nothing is lost silently.
      await recordNotificationFailure(parsed.fromPhone, 'admin_alert', [errMsg], 'FREEFORM', `Inbound webhook error (${parsed.messageId}): ${errMsg}`);
      await sendWhatsAppText(
        parsed.fromPhone,
        'Sorry, we ran into a temporary issue processing your message. Please try again in a moment or call BiharCabs support.'
      ).catch((sendErr) => console.error('[WhatsApp Webhook] Fallback user reply failed:', sendErr));
      await notifyAdmins(
        `⚠️ WhatsApp inbound message from ${parsed.fromPhone} (${parsed.messageType || 'unknown'}) failed mid-processing: ${errMsg.slice(0, 200)}`
      ).catch((admErr) => console.error('[WhatsApp Webhook] Admin alert failed:', admErr));
    }
  }

  return NextResponse.json({
    status: failed > 0 ? 'partial_error' : duplicates > 0 && processed === 0 ? 'duplicate_ignored' : 'success',
    processed,
    duplicates,
    failed,
  });
}
