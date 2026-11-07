import { NextRequest, NextResponse } from 'next/server';
import { getMetaWhatsAppConfig } from '@/lib/settings';
import { parseIncomingWebhook, logWhatsAppMessage } from '@/lib/whatsapp';
import { processIncomingWhatsAppMessage } from '@/lib/whatsapp-bot';

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
  try {
    const body = await req.json();
    const parsed = parseIncomingWebhook(body);

    if (!parsed || !parsed.fromPhone) {
      // Return 200 immediately to acknowledge Meta webhooks
      return NextResponse.json({ status: 'ignored_or_no_message' });
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
